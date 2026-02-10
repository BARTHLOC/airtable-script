
/***********************
 * CONFIG
 ***********************/
let url = "url secret cobra";
let contratsTable = base.getTable("ContratsImport");
let vehiculeTable = base.getTable("Véhicules");

/***********************
 * UTILS
 ***********************/
function stripHtml(html) {
    if (!html) return "";
    return html
        .replace(/<[^>]*>/g, "")
        .replace(/&nbsp;/g, " ")
        .trim();
}

function extractPlaque(text) {
    if (!text) return "";

    let clean = text.replace(/\s+/g, " ").trim().toUpperCase();
    let match = clean.match(/([A-Z0-9]{3,})$/);

    if (!match) return "";

    let candidate = match[1];

    if (candidate.endsWith("CC") || candidate === "3T") return "";
    if (!/\d/.test(candidate)) return "";

    return candidate;
}

/***********************
 * FETCH + PARSE COBRA (ULTRA ROBUST)
 ***********************/
let response = await fetch(url);
let rawText = await response.text();
rawText = rawText.trim();

// retirer encapsulation string
if (
    (rawText.startsWith('"') && rawText.endsWith('"')) ||
    (rawText.startsWith("'") && rawText.endsWith("'"))
) {
    rawText = rawText.slice(1, -1);
}

// nettoyage des échappements
rawText = rawText
    .replace(/\\"/g, '"')
    .replace(/\\n/g, "")
    .replace(/\\r/g, "")
    .replace(/\\t/g, "");

// FIX HTML cassant le JSON : class="..." => class='...'
rawText = rawText.replace(/class="/g, "class='");
rawText = rawText.replace(/">/g, "'>");

// FIX 1 : ajouter les guillemets sur les clés
rawText = rawText.replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":');

// FIX 2 : supprimer les virgules finales avant } ou ]
rawText = rawText.replace(/,\s*([}\]])/g, "$1");

// sécurité
if (!rawText.includes('"data"') || !rawText.includes('"collections"')) {
    console.log(rawText.slice(0, 800));
    throw new Error("Réponse Cobra incomplète ou format inattendu");
}

// parse JSON
let data;
try {
    data = JSON.parse(rawText);
} catch (e) {
    console.log(rawText.slice(0, 1500));
    throw new Error("Impossible de parser le JSON Cobra : " + e.message);
}

/***********************
 * MAP VEHICULES COBRA
 ***********************/
let vehiculesMap = {};
for (let v of data.collections.list_objets) {
    let cleanLabel = stripHtml(v.label);
    let plaque = extractPlaque(cleanLabel);

    vehiculesMap[v.key] = {
        label: cleanLabel,
        plaque: plaque,
    };
}

/***********************
 * MAP VEHICULES AIRTABLE
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
 * INDEX CONTRATS EXISTANTS
 ***********************/
let existingContrats = await contratsTable.selectRecordsAsync();
let contratsByNum = {};

for (let record of existingContrats.records) {
    let num = record.getCellValueAsString("NumContrat");
    if (num) contratsByNum[num] = record;
}

/***********************
 * PREPARATION CREATE / UPDATE
 ***********************/
let recordsToCreate = [];
let recordsToUpdate = [];
let skipped = 0;

// Anti doublons update
let updatedIds = new Set();

// Anti doublons create dans le même run
let createdNums = new Set();

// DEBUG counters
let ignoredNoStartDate = 0;
let ignoredNoVehiculeMap = 0;
let ignoredNoPlaque = 0;
let ignoredPlaqueNotInAirtable = 0;

for (let item of data.data) {
    if (!item.start_date) {
        ignoredNoStartDate++;
        continue;
    }

    // IMPORTANT : si pas de NumContrat, on met un identifiant unique basé sur l'id Cobra
    let numContrat = item.NumContrat ? item.NumContrat : ("ID-" + item.id);

    // éviter doublons de création dans le même run
    if (createdNums.has(numContrat)) {
        continue;
    }

    let vehData = vehiculesMap[item.IDObjet];
    if (!vehData) {
        ignoredNoVehiculeMap++;
        continue;
    }

    if (!vehData.plaque) {
        ignoredNoPlaque++;
        continue;
    }

    let vehiculeRecordId = plaqueToRecordId[vehData.plaque];
    if (!vehiculeRecordId) {
        ignoredPlaqueNotInAirtable++;
        continue;
    }

    let fieldsPayload = {
        "Nom Client": stripHtml(item.text || "Client inconnu"),
        vehicules: [{ id: vehiculeRecordId }],
        DateDebut: new Date(item.start_date),
        DateFin: item.end_date ? new Date(item.end_date) : null,
    };

    let existingRecord = contratsByNum[numContrat];

    // CREATE
    if (!existingRecord) {
        recordsToCreate.push({
            fields: {
                NumContrat: numContrat,
                ...fieldsPayload,
            },
        });

        createdNums.add(numContrat);
        continue;
    }

    // UPDATE si véhicule différent
    let currentVehicules = existingRecord.getCellValue("vehicules") || [];
    let currentVehiculeId = currentVehicules.length ? currentVehicules[0].id : null;

    if (currentVehiculeId !== vehiculeRecordId) {
        if (!updatedIds.has(existingRecord.id)) {
            recordsToUpdate.push({
                id: existingRecord.id,
                fields: fieldsPayload,
            });
            updatedIds.add(existingRecord.id);
        }
    } else {
        skipped++;
    }
}

/***********************
 * SAUVEGARDE DES COMPTEURS
 ***********************/
let totalCreate = recordsToCreate.length;
let totalUpdate = recordsToUpdate.length;

/***********************
 * INSERTION / UPDATE
 ***********************/
while (recordsToCreate.length) {
    await contratsTable.createRecordsAsync(recordsToCreate.splice(0, 50));
}

while (recordsToUpdate.length) {
    await contratsTable.updateRecordsAsync(recordsToUpdate.splice(0, 50));
}

/***********************
 * FIN + DEBUG
 ***********************/
output.set("Créés", totalCreate);
output.set("Mis à jour", totalUpdate);
output.set("Inchangés", skipped);

output.set("Ignorés - pas de start_date", ignoredNoStartDate);
output.set("Ignorés - véhicule introuvable Cobra", ignoredNoVehiculeMap);
output.set("Ignorés - pas de plaque", ignoredNoPlaque);
output.set("Ignorés - plaque absente Airtable", ignoredPlaqueNotInAirtable);

