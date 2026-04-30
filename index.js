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

const TABLE_MAP = [
  { nameA: "IFC_4 3 ADD2 Enum",   idA: "mmyxrzc3owyxekh" },
  { nameA: "IFC_4 ADD2 TC1 Enum", idA: "mk6utn7mnlnuyc6" },
  { nameA: "IFC_2x3 TC1 Enum",    idA: "mtpquy5h9bpybmd" },
];

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

async function getTablesB() {
  const data = await apiFetch(`/api/v1/db/meta/projects/${BASE_B_ID}/tables`);
  return data.list || [];
}

async function getFieldsA(tableIdA) {
  const data = await apiFetch(`/api/v1/db/meta/tables/${tableIdA}`);
  return data.columns || [];
}

async function createTableInB(tableName, fieldsA) {
  console.log(`Creo tabella "${tableName}" in Base B...`);

  const skipFields = new Set(["Id", "CreatedAt", "UpdatedAt", "nc_order"]);
  // LinkToAnotherRecord, Lookup e Rollup non sono replicabili cross-base
  // Formula viene convertita in SingleLineText e il valore calcolato viene copiato
  const skipTypes = new Set(["LinkToAnotherRecord", "Lookup", "Rollup"]);

  const columns = fieldsA
    .filter(f => !skipFields.has(f.title) && !skipTypes.has(f.uidt))
    .map(f => {
      // I campi Formula vengono salvati come testo (il valore calcolato viene copiato dal record)
      if (f.uidt === "Formula") {
        return { title: f.title, uidt: "SingleLineText" };
      }
      const col = {
        title: f.title,
        uidt: f.uidt || "SingleLineText",
      };
      if ((f.uidt === "SingleSelect" || f.uidt === "MultiSelect") && f.colOptions?.options) {
        col.colOptions = {
          options: f.colOptions.options.map(o => ({ title: o.title, color: o.color })),
        };
      }
      return col;
    });

  columns.push({ title: "RefID_A", uidt: "SingleLineText" });

  const body = { title: tableName, columns };
  const created = await apiFetch(`/api/v1/db/meta/projects/${BASE_B_ID}/tables`, {
    method: "POST",
    body: JSON.stringify(body),
  });

  console.log(`Tabella "${tableName}" creata in B con id: ${created.id}`);
  return created.id;
}

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

async function findInB(tableBId, refValue) {
  const data = await apiFetch(
    `/api/v1/db/data/noco/${BASE_B_ID}/${tableBId}?where=(RefID_A,eq,${encodeURIComponent(refValue)})&limit=1`
  );
  return data?.list?.[0] || null;
}

async function createInB(tableBId, record, fieldsMetaA) {
  const { Id, CreatedAt, UpdatedAt, ...fields } = record;

  // Converti i valori dei campi Formula in stringa (sono salvati come SingleLineText in B)
  const payload = { RefID_A: String(Id) };
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    // Converti oggetti/array in stringa (es. valori formula complessi)
    payload[key] = typeof value === "object" ? JSON.stringify(value) : String(value);
  }

  return await apiFetch(`/api/v1/db/data/noco/${BASE_B_ID}/${tableBId}`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

function findTableEntry(tableIdA) {
  return TABLE_MAP.find(e => e.idA === tableIdA);
}

// Attendi N millisecondi
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Legge tutti i record di una tabella in A con paginazione e delay anti-rate-limit
async function getAllRecordsA(tableIdA) {
  const allRecords = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const data = await apiFetch(
      `/api/v1/db/data/noco/${BASE_A_ID}/${tableIdA}?limit=${limit}&offset=${offset}`
    );
    const records = data?.list || [];
    allRecords.push(...records);
    if (records.length < limit) break;
    offset += limit;
    await sleep(500); // pausa 500ms tra una pagina e l'altra
  }
  return allRecords;
}

// Carica tutti i RefID_A già presenti in B in un Set (una sola scansione)
async function getExistingRefIdsB(tableBId) {
  const existing = new Set();
  let offset = 0;
  const limit = 100;
  while (true) {
    const data = await apiFetch(
      `/api/v1/db/data/noco/${BASE_B_ID}/${tableBId}?fields=RefID_A&limit=${limit}&offset=${offset}`
    );
    const records = data?.list || [];
    for (const r of records) {
      if (r.RefID_A) existing.add(String(r.RefID_A));
    }
    if (records.length < limit) break;
    offset += limit;
    await sleep(500);
  }
  return existing;
}

// Sincronizza tutti i record di una tabella da A a B
async function syncTable(entry) {
  const tableBId = await resolveTableB(entry);

  // Carica in memoria i RefID già presenti in B (evita N chiamate di ricerca)
  console.log(`  Carico RefID esistenti in B per "${entry.nameA}"...`);
  const existingRefs = await getExistingRefIdsB(tableBId);
  console.log(`  Trovati ${existingRefs.size} record già in B`);

  const records = await getAllRecordsA(entry.idA);
  let created = 0;
  let skipped = 0;
  for (const record of records) {
    if (existingRefs.has(String(record.Id))) { skipped++; continue; }
    await createInB(tableBId, record);
    created++;
    await sleep(300); // pausa 300ms tra un inserimento e l'altro
  }
  return { table: entry.nameA, total: records.length, created, skipped };
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

    const tableIdA = event?.data?.table_id || event?.table_id;
    if (!tableIdA) {
      return res.status(400).json({ error: "table_id mancante nel payload webhook" });
    }

    const entry = findTableEntry(tableIdA);
    if (!entry) {
      console.warn(`Tabella ${tableIdA} non in TABLE_MAP, ignorata`);
      return res.status(200).json({ message: "Tabella non mappata, ignorata" });
    }

    const tableBId = await resolveTableB(entry);

    const existing = await findInB(tableBId, String(record.Id));
    if (existing) {
      console.log(`Record ${record.Id} già in B — nessuna azione`);
      return res.status(200).json({ message: "Record già esistente in B, ignorato" });
    }

    const created = await createInB(tableBId, record);
    console.log(`Record ${record.Id} creato in B con Id: ${created.Id}`);
    return res.status(200).json({ message: "Record creato in B", id: created.Id });

  } catch (err) {
    console.error("Errore webhook:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// --- ENDPOINTS ---

// Verifica/crea tabelle in B
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

// Sincronizza tutti i record esistenti da A a B (salta i duplicati)
app.get("/sync-all", async (req, res) => {
  try {
    console.log("Avvio sincronizzazione completa A → B...");
    const results = [];
    for (const entry of TABLE_MAP) {
      console.log(`Sincronizzo tabella "${entry.nameA}"...`);
      const result = await syncTable(entry);
      console.log(`  → creati: ${result.created}, saltati: ${result.skipped}`);
      results.push(result);
    }
    return res.json({ message: "Sincronizzazione completata", results });
  } catch (err) {
    console.error("Errore sync-all:", err.message);
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
