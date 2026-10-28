"use strict";

const path = require("path");
const express = require("express");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
const PIN = (process.env.APP_PIN || "").trim();

// Fem faste personer. Rekkefølgen her er den som lagres i databasen (0–4).
const DEFAULT_NAMES = ["Lisell", "Annika", "Lina", "Johanna", "Elin"];
const N = DEFAULT_NAMES.length;
const ALL = DEFAULT_NAMES.map((_, i) => i);

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL mangler. Sett den som miljøvariabel.");
  process.exit(1);
}
if (!PIN) {
  console.warn("ADVARSEL: APP_PIN er ikke satt. Siden er åpen for alle som har lenken.");
}

// Neon og de fleste eksterne databaser krever SSL.
// Render sin interne database-URL gjør det ikke: sett da PGSSL=off.
const useSsl = (process.env.PGSSL || "on").toLowerCase() !== "off";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  max: 4,
  idleTimeoutMillis: 30000
});

const app = express();
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public"), {
  maxAge: "1h",
  setHeaders: (res, filePath) => {
    // Service workeren må aldri mellomlagres av nettleseren.
    if (filePath.endsWith("sw.js")) res.set("Cache-Control", "no-cache");
  }
}));

/* ---------- oppsett av tabeller ----------
   Tabellene har prefikset g5_ slik at de aldri kolliderer med
   tabellene til Linn & Alex-appen, selv om dere bruker samme database. */
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS g5_periods (
      id          SERIAL PRIMARY KEY,
      started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      settled_at  TIMESTAMPTZ,
      totals      JSONB NOT NULL DEFAULT '[]',
      transfers   JSONB NOT NULL DEFAULT '[]',
      names       JSONB
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS g5_expenses (
      id          SERIAL PRIMARY KEY,
      period_id   INTEGER NOT NULL REFERENCES g5_periods(id) ON DELETE CASCADE,
      date        DATE NOT NULL,
      descr       TEXT NOT NULL DEFAULT '',
      amount      NUMERIC(12,2) NOT NULL,
      payer       SMALLINT NOT NULL CHECK (payer BETWEEN 0 AND ${N - 1}),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Hvem som deler hvert utlegg. Eldre utlegg uten valg deles på alle fem.
  await pool.query(`ALTER TABLE g5_expenses ADD COLUMN IF NOT EXISTS shares JSONB NOT NULL DEFAULT '${JSON.stringify(ALL)}'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS g5_expenses_period_idx ON g5_expenses (period_id);`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS g5_config (
      id                INTEGER PRIMARY KEY DEFAULT 1,
      names             JSONB NOT NULL,
      current_period_id INTEGER REFERENCES g5_periods(id),
      CONSTRAINT g5_config_single_row CHECK (id = 1)
    );
  `);

  const { rows } = await pool.query("SELECT id FROM g5_config WHERE id = 1");
  if (rows.length === 0) {
    const p = await pool.query("INSERT INTO g5_periods DEFAULT VALUES RETURNING id");
    await pool.query(
      "INSERT INTO g5_config (id, names, current_period_id) VALUES (1, $1, $2)",
      [JSON.stringify(DEFAULT_NAMES), p.rows[0].id]
    );
    console.log("Første periode opprettet.");
  }
}

/* ---------- enkel kodelås ---------- */
const failures = new Map();

app.use("/api", (req, res, next) => {
  if (!PIN) return next();
  const given = (req.get("x-pin") || "").trim();
  if (given === PIN) {
    failures.delete(req.ip);
    return next();
  }
  const n = (failures.get(req.ip) || 0) + 1;
  failures.set(req.ip, n);
  setTimeout(() => res.status(401).json({ error: "feil_kode" }), Math.min(n * 300, 3000));
});

/* ---------- hjelpere ---------- */
function num(v) {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}
function cleanName(v, fallback) {
  const s = String(v == null ? "" : v).trim().slice(0, 18);
  return s || fallback;
}
function cleanNames(list, current) {
  const src = Array.isArray(list) ? list : [];
  const out = [];
  for (let i = 0; i < N; i++) out.push(cleanName(src[i], current[i] || DEFAULT_NAMES[i]));
  return out;
}
function namesOf(v) {
  return Array.isArray(v) && v.length === N ? v : DEFAULT_NAMES.slice();
}
function cleanShares(v) {
  if (!Array.isArray(v)) return ALL.slice();
  const set = new Set();
  v.forEach(x => {
    const i = parseInt(x, 10);
    if (Number.isInteger(i) && i >= 0 && i < N) set.add(i);
  });
  return set.size ? Array.from(set).sort((a, b) => a - b) : ALL.slice();
}
function cleanPayer(v) {
  const p = parseInt(v, 10);
  return Number.isInteger(p) && p >= 0 && p < N ? p : 0;
}

/* Hvert utlegg deles likt på dem som er huket av som deltakere.
   Oppgjøret finner færrest mulig betalinger som gjør alle kvitt.
   Alt regnes i 1/60 øre (60 er delelig med 1–5), så delingen blir eksakt. */
const UNIT = 60;
function settlement(expenses) {
  const bal = new Array(N).fill(0);
  expenses.forEach(e => {
    const ore = Math.round(num(e.amount) * 100);
    const sh = cleanShares(e.shares);
    bal[cleanPayer(e.payer)] += ore * UNIT;
    const part = (ore * UNIT) / sh.length;
    sh.forEach(i => { bal[i] -= part; });
  });
  const cred = [], debt = [];
  bal.forEach((b, i) => {
    if (b > 0) cred.push({ i, v: b });
    else if (b < 0) debt.push({ i, v: -b });
  });
  cred.sort((x, y) => y.v - x.v);
  debt.sort((x, y) => y.v - x.v);
  const out = [];
  let ci = 0, di = 0;
  while (ci < cred.length && di < debt.length) {
    const m = Math.min(cred[ci].v, debt[di].v);
    const ore = Math.round(m / UNIT);
    if (ore >= 1) out.push({ from: debt[di].i, to: cred[ci].i, amount: ore / 100 });
    cred[ci].v -= m;
    debt[di].v -= m;
    if (cred[ci].v === 0) ci++;
    if (debt[di].v === 0) di++;
  }
  return out;
}

async function readState() {
  const cfg = (await pool.query("SELECT * FROM g5_config WHERE id = 1")).rows[0];
  const periods = (await pool.query(
    "SELECT id, started_at, settled_at, totals, transfers, names FROM g5_periods ORDER BY id DESC LIMIT 60"
  )).rows;
  const expenses = (await pool.query(
    "SELECT id, to_char(date, 'YYYY-MM-DD') AS date, descr, amount, payer, shares FROM g5_expenses WHERE period_id = $1 ORDER BY date DESC, id DESC",
    [cfg.current_period_id]
  )).rows;

  return {
    config: {
      names: namesOf(cfg.names),
      currentPeriodId: cfg.current_period_id
    },
    periods: periods.map(p => ({
      id: p.id,
      startedAt: p.started_at,
      settledAt: p.settled_at,
      totals: Array.isArray(p.totals) ? p.totals.map(num) : [],
      transfers: Array.isArray(p.transfers) ? p.transfers : [],
      names: p.names ? namesOf(p.names) : null
    })),
    expenses: expenses.map(e => ({
      id: e.id,
      date: e.date,
      desc: e.descr,
      amount: num(e.amount),
      payer: e.payer,
      shares: cleanShares(e.shares)
    }))
  };
}

function fail(res, err) {
  console.error(err);
  res.status(500).json({ error: "serverfeil" });
}

function readExpenseBody(body) {
  const amount = Number(body.amount);
  if (!isFinite(amount) || amount <= 0) return null;
  return {
    amount: Math.round(amount * 100) / 100,
    payer: cleanPayer(body.payer),
    shares: JSON.stringify(cleanShares(body.shares)),
    date: /^\d{4}-\d{2}-\d{2}$/.test(body.date || "")
      ? body.date
      : new Date().toISOString().slice(0, 10),
    descr: String(body.desc || "").trim().slice(0, 60)
  };
}

/* ---------- API ---------- */
app.get("/api/state", async (req, res) => {
  try {
    res.json(await readState());
  } catch (e) { fail(res, e); }
});

app.post("/api/expenses", async (req, res) => {
  try {
    const x = readExpenseBody(req.body);
    if (!x) return res.status(400).json({ error: "ugyldig_belop" });

    const cfg = (await pool.query("SELECT current_period_id FROM g5_config WHERE id = 1")).rows[0];
    await pool.query(
      "INSERT INTO g5_expenses (period_id, date, descr, amount, payer, shares) VALUES ($1, $2, $3, $4, $5, $6)",
      [cfg.current_period_id, x.date, x.descr, x.amount, x.payer, x.shares]
    );
    res.json(await readState());
  } catch (e) { fail(res, e); }
});

app.put("/api/expenses/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "ugyldig_id" });

    const x = readExpenseBody(req.body);
    if (!x) return res.status(400).json({ error: "ugyldig_belop" });

    await pool.query(
      "UPDATE g5_expenses SET date = $1, descr = $2, amount = $3, payer = $4, shares = $5 WHERE id = $6",
      [x.date, x.descr, x.amount, x.payer, x.shares, id]
    );
    res.json(await readState());
  } catch (e) { fail(res, e); }
});

app.get("/api/periods/:id/expenses", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "ugyldig_id" });
    const rows = (await pool.query(
      "SELECT id, to_char(date, 'YYYY-MM-DD') AS date, descr, amount, payer, shares FROM g5_expenses WHERE period_id = $1 ORDER BY date DESC, id DESC",
      [id]
    )).rows;
    res.json({
      expenses: rows.map(e => ({
        id: e.id, date: e.date, desc: e.descr, amount: num(e.amount), payer: e.payer,
        shares: cleanShares(e.shares)
      }))
    });
  } catch (e) { fail(res, e); }
});

app.delete("/api/expenses/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "ugyldig_id" });
    await pool.query("DELETE FROM g5_expenses WHERE id = $1", [id]);
    res.json(await readState());
  } catch (e) { fail(res, e); }
});

app.post("/api/names", async (req, res) => {
  try {
    const cfg = (await pool.query("SELECT names FROM g5_config WHERE id = 1")).rows[0];
    const names = cleanNames(req.body.names, namesOf(cfg.names));
    await pool.query("UPDATE g5_config SET names = $1 WHERE id = 1", [JSON.stringify(names)]);
    res.json(await readState());
  } catch (e) { fail(res, e); }
});

app.post("/api/settle", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cfg = (await client.query("SELECT * FROM g5_config WHERE id = 1 FOR UPDATE")).rows[0];
    const pid = cfg.current_period_id;
    const names = namesOf(cfg.names);

    const rows = (await client.query(
      "SELECT amount, payer, shares FROM g5_expenses WHERE period_id = $1",
      [pid]
    )).rows;
    const totals = new Array(N).fill(0);
    rows.forEach(r => { totals[cleanPayer(r.payer)] += num(r.amount); });
    for (let i = 0; i < N; i++) totals[i] = Math.round(totals[i] * 100) / 100;
    const transfers = settlement(rows);

    await client.query(
      `UPDATE g5_periods SET settled_at = now(), totals = $1, transfers = $2, names = $3
       WHERE id = $4`,
      [JSON.stringify(totals), JSON.stringify(transfers), JSON.stringify(names), pid]
    );

    const np = (await client.query("INSERT INTO g5_periods DEFAULT VALUES RETURNING id")).rows[0];

    await client.query(
      "UPDATE g5_config SET current_period_id = $1, names = $2 WHERE id = 1",
      [np.id, JSON.stringify(cleanNames(req.body.names, names))]
    );

    await client.query("COMMIT");
    res.json(await readState());
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    fail(res, e);
  } finally {
    client.release();
  }
});

app.post("/api/periods/:id/reopen", async (req, res) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "ugyldig_id" });

    await client.query("BEGIN");
    const cfg = (await client.query("SELECT * FROM g5_config WHERE id = 1 FOR UPDATE")).rows[0];
    const current = cfg.current_period_id;

    if (id === current) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "allerede_apen" });
    }

    const p = (await client.query("SELECT settled_at FROM g5_periods WHERE id = $1", [id])).rows[0];
    if (!p) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "finnes_ikke" });
    }
    if (!p.settled_at) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "ikke_gjort_opp" });
    }

    // Utlegg lagt inn etter oppgjøret følger med inn i perioden som gjenåpnes.
    await client.query("UPDATE g5_expenses SET period_id = $1 WHERE period_id = $2", [id, current]);

    await client.query(
      "UPDATE g5_periods SET settled_at = NULL, totals = '[]', transfers = '[]' WHERE id = $1",
      [id]
    );

    await client.query("UPDATE g5_config SET current_period_id = $1 WHERE id = 1", [id]);
    await client.query("DELETE FROM g5_periods WHERE id = $1", [current]);

    await client.query("COMMIT");
    res.json(await readState());
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    fail(res, e);
  } finally {
    client.release();
  }
});

app.get("/healthz", (req, res) => res.type("text").send("ok"));

/* ---------- start ---------- */
initDb()
  .then(() => {
    app.listen(PORT, () => console.log("Utleggsoversikt (5 personer) kjører på port " + PORT));
  })
  .catch(err => {
    console.error("Klarte ikke å sette opp databasen:", err);
    process.exit(1);
  });
