let url = "url secret cobra";
let contratsTable = base.getTable("ContratsImport");
let vehiculeTable = base.getTable("Véhicules");

/***********************
 * UTILS
 ***********************/
function stripHtml(html) {
    if (!html) return "";
    return html.replace(/<[^>]*>/g, "").trim();
}

// 🔥 EXTRACTION ROBUSTE DE LA PLAQUE
function extractPlaque(text) {
    if (!text) return "";

    let clean = text.replace(/\s+/g, " ").trim().toUpperCase();

    let match = clean.match(/([A-Z0-9]{3,})$/);
    if (!match) return "";

    let candidate = match[1];

    if (
        candidate.endsWith("CC") ||
        candidate === "3T"
    ) return "";

    if (!/\d/.test(candidate)) return "";

    return candidate;
}

/***********************
 * FETCH DATA COBRA
 ***********************/
let response = await fetch(url);
let rawText = await response.text();
let data = eval("(" + rawText + ")");

/***********************
 * MAP VEHICULES COBRA
 ***********************/
let vehiculesMap = {};
for (let v of data.collections.list_objets) {
    let cleanLabel = stripHtml(v.label);
    let plaque = extractPlaque(cleanLabel);
    vehiculesMap[v.key] = { label: cleanLabel, plaque };
}

/***********************
 * MAP VEHICULES AIRTABLE (plaque → record.id)
 ***********************/
let airtableVehicules = await vehiculeTable.selectRecordsAsync();
let plaqueToRecordId = {};

for (let record of airtableVehicules.records) {
    let plaque = record.getCellValueAsString("Plaque");
    if (plaque) {
        plaqueToRecordId[plaque.toUpperCase()] = record.id;
    }
}

/***********************
 * INDEX DES NUMCONTRAT EXISTANTS
 ***********************/
let existingContrats = await contratsTable.selectRecordsAsync();
let existingNumContrats = new Set();

for (let record of existingContrats.records) {
    let num = record.getCellValueAsString("NumContrat");
    if (num) existingNumContrats.add(num);
}

/***********************
 * PREPARATION DES CONTRATS
 ***********************/
let recordsToCreate = [];
let skipped = 0;

for (let item of data.data) {

    let numContrat = item.NumContrat || "Sans numéro";

    // 🛑 DOUBLON → SKIP
    if (existingNumContrats.has(numContrat)) {
        skipped++;
        continue;
    }

    let vehData = vehiculesMap[item.IDObjet];
    if (!vehData) continue;

    let plaque = vehData.plaque;
    if (!plaque) continue;

    let vehiculeRecordId = plaqueToRecordId[plaque];
    if (!vehiculeRecordId) continue;

    // ✅ Nom client depuis item.text
    let nomClient = stripHtml(item.text || "Client inconnu");

    recordsToCreate.push({
        fields: {
            "NumContrat": numContrat,
            "Nom Client": nomClient,
            "DateDebut": item.start_date ? new Date(item.start_date).toISOString() : null,
            "DateFin": item.end_date ? new Date(item.end_date).toISOString() : null,
            "vehicules": [{ id: vehiculeRecordId }]
        }
    });

    // Pour éviter doublons dans le même run
    existingNumContrats.add(numContrat);
}

output.text(`🆕 Contrats à créer : ${recordsToCreate.length}`);
output.text(`⏭️ Contrats ignorés (doublons NumContrat) : ${skipped}`);

/***********************
 * INSERTION PAR LOTS
 ***********************/
while (recordsToCreate.length > 0) {
    await contratsTable.createRecordsAsync(recordsToCreate.slice(0, 50));
    recordsToCreate = recordsToCreate.slice(50);
}

output.text("✅ IMPORT TERMINÉ – DÉDOUBLONNAGE PAR NumContrat ET NOM CLIENT");
