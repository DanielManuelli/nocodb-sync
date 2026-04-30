const express = require("express");
const app = express();
app.use(express.json());
 
const NOCODB_URL = "https://app.nocodb.com";
const API_TOKEN = process.env.API_TOKEN;
const BASE_A_ID = process.env.BASE_A_ID;
const BASE_B_ID = process.env.BASE_B_ID;
 
const headers = {
  "xc-token": API_TOKEN,
  "Content-Type": "application/json",
};
 
// Mappa tabelle A → B (Table ID A: nome tabella)
// Il nome viene usato per trovare o creare la tabella corrispondente in B
const TABLE_MAP = [
  { nameA: "IFC_4 3 ADD2 Enum",   idA: "mmyxrzc3owyxekh" },
  { nameA: "IFC_4 ADD2 TC1 Enum", idA: "mk6utn7mnlnuyc6" },
  { nameA: "IFC_2x3 TC1 Enum",    idA: "mtpquy5h9bpybmd" },
];
 
// Cache: tableIdA → tableIdB (popolata a runtime)
const tableBCache = {};
 
// --- UTILS ---
 
async function apiFetch(path, options = {}) {
  const res = await fetch(`${NOCODB_URL}${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`API error ${res.status} on ${path}: ${err}`);
  }
  return res.json();
}
 
// Recupera tutte le tabelle di Base B
async function getTablesB() {
  const data = await apiFetch(`/api/v1/db/meta/projects/${BASE_B_ID}/tables`);
  return data.list || [];
}
 
// Recupera i campi di una tabella in Base A
async function getFieldsA(tableIdA) {
  const data = await apiFetch(`/api/v1/db/meta/tables/${tableIdA}`);
  return data.columns || [];
}
 
// Crea una tabella in Base B con gli stessi campi di A
async function createTableInB(tableName, fieldsA) {
  console.log(`Creo tabella "${tableName}" in Base B...`);
 
  const skipFields = new Set(["Id", "CreatedAt", "UpdatedAt", "nc_order"]);
  const skipTypes = new Set(["LinkToAnotherRecord", "Lookup", "Rollup", "Formula"]);
 
  const columns = fieldsA
    .filter(f => !skipFields.has(f.title) && !skipTypes.has(f.uidt))
    .map(f => {
      const col = {
        title: f.title,
        uidt: f.uidt || "SingleLineText",
      };
      // Copia le opzioni per campi SingleSelect e MultiSelect
      if ((f.uidt === "SingleSelect" || f.uidt === "MultiSelect") && f.colOptions?.options) {
        col.colOptions = {
          options: f.colOptions.options.map(o => ({ title: o.title, color: o.color })),
        };
      }
      return col;
    });
 
  // Aggiungi campo RefID_A per tracciare l'origine
  columns.push({ title: "RefID_A", uidt: "SingleLineText" });
 
  const body = { title: tableName, columns };
  const created = await apiFetch(`/api/v1/db/meta/projects/${BASE_B_ID}/tables`, {
    method: "POST",
    body: JSON.stringify(body),
  });
 
  console.log(`Tabella "${tableName}" creata in B con id: ${created.id}`);
  return created.id;
}
 
// Trova o crea la tabella in B, restituisce il suo ID
async function resolveTableB(entry) {
  if (tableBCache[entry.idA]) return tableBCache[entry.idA];
 
  const tablesB = await getTablesB();
  const existing = tablesB.find(t => t.title === entry.nameA);
 
  let tableBId;
  if (existing) {
    console.log(`Tabella "${entry.nameA}" già presente in B: ${existing.id}`);
    tableBId = existing.id;
  } else {
    const fieldsA = await getFieldsA(entry.idA);
    tableBId = await createTableInB(entry.nameA, fieldsA);
  }
 
  tableBCache[entry.idA] = tableBId;
  return tableBId;
}
 
// Cerca un record in Base B tramite RefID_A
async function findInB(tableBId, refValue) {
  const data = await apiFetch(
    `/api/v1/db/data/noco/${BASE_B_ID}/${tableBId}?where=(RefID_A,eq,${encodeURIComponent(refValue)})&limit=1`
  );
  return data?.list?.[0] || null;
}
 
// Crea un record in Base B
async function createInB(tableBId, record) {
  const { Id, CreatedAt, UpdatedAt, ...fields } = record;
  const payload = { ...fields, RefID_A: String(Id) };
 
  return await apiFetch(`/api/v1/db/data/noco/${BASE_B_ID}/${tableBId}`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
 
// Trova la entry della mappa in base al Table ID A
function findTableEntry(tableIdA) {
  return TABLE_MAP.find(e => e.idA === tableIdA);
}
 
// --- WEBHOOK ---
 
app.post("/webhook", async (req, res) => {
  try {
    const event = req.body;
    console.log("Webhook ricevuto:", JSON.stringify(event, null, 2));
 
    const record = event?.data?.rows?.[0];
    if (!record) {
      return res.status(200).json({ message: "Nessun record da elaborare" });
    }
 
    // Recupera quale tabella ha generato l'evento
    const tableIdA = event?.data?.table_id || event?.table_id;
    if (!tableIdA) {
      return res.status(400).json({ error: "table_id mancante nel payload webhook" });
    }
 
    const entry = findTableEntry(tableIdA);
    if (!entry) {
      console.warn(`Tabella ${tableIdA} non in TABLE_MAP, ignorata`);
      return res.status(200).json({ message: "Tabella non mappata, ignorata" });
    }
 
    // Trova o crea la tabella corrispondente in B
    const tableBId = await resolveTableB(entry);
 
    // Controlla duplicati
    const existing = await findInB(tableBId, String(record.Id));
    if (existing) {
      console.log(`Record ${record.Id} già in B — nessuna azione`);
      return res.status(200).json({ message: "Record già esistente in B, ignorato" });
    }
 
    // Crea il record in B
    const created = await createInB(tableBId, record);
    console.log(`Record ${record.Id} creato in B con Id: ${created.Id}`);
    return res.status(200).json({ message: "Record creato in B", id: created.Id });
 
  } catch (err) {
    console.error("Errore webhook:", err.message);
    return res.status(500).json({ error: err.message });
  }
});
 
// Endpoint per creare/verificare tutte le tabelle in B all'avvio
app.get("/setup", async (req, res) => {
  try {
    const results = [];
    for (const entry of TABLE_MAP) {
      const tableBId = await resolveTableB(entry);
      results.push({ table: entry.nameA, tableBId });
    }
    return res.json({ message: "Setup completato", results });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
 
// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "NocoDB Sync in esecuzione" });
});
 
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server avviato sulla porta ${PORT}`);
  // All'avvio verifica/crea automaticamente le tabelle in B
  console.log("Verifico tabelle in Base B...");
  for (const entry of TABLE_MAP) {
    try {
      await resolveTableB(entry);
    } catch (err) {
      console.error(`Errore setup tabella ${entry.nameA}:`, err.message);
    }
  }
  console.log("Setup completato.");
});
 
