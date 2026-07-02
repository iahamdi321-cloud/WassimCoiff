// api/notify.js — Fonction serverless Vercel (Firebase Cloud Messaging)
// Envoie une notification push au téléphone du gérant à chaque réservation.
//
// Variable d'environnement à définir dans Vercel (Settings -> Environment Variables) :
//   SERVICE_ACCOUNT  ->  colle ici TOUT le contenu du fichier .json du compte de service Firebase
//
// DIAGNOSTIC (à ouvrir dans le navigateur) :
//   https://TON-SITE.vercel.app/api/notify         -> affiche l'état (clé + téléphones enregistrés)
//   https://TON-SITE.vercel.app/api/notify?test=1  -> envoie une notification de TEST au gérant

const admin = require("firebase-admin");

// Initialise Firebase Admin une seule fois (Vercel réutilise l'instance entre les appels)
if (!admin.apps.length && process.env.SERVICE_ACCOUNT) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.SERVICE_ACCOUNT))
    });
  } catch (e) { /* clé invalide/mal collée : "configured" restera false */ }
}

// Lit les jetons du gérant (plusieurs appareils possibles)
async function readAdminTokens() {
  const ref = admin.firestore().doc("fcmTokens/admin");
  const snap = await ref.get();
  let tokens = [];
  if (snap.exists) {
    const d = snap.data();
    if (Array.isArray(d.tokens)) tokens = d.tokens;
    else if (d.token) tokens = [d.token];
  }
  return { ref, tokens: [...new Set(tokens)].filter(Boolean) };
}

// Compose + envoie la notification au gérant. Renvoie un petit résumé.
async function sendToAdmin(data) {
  const nom     = (data.nom     || "Client").toString().slice(0, 80);
  const service = (data.service || "").toString().slice(0, 80);
  const type    = (data.type    || "file").toString();
  const jour    = (data.jour    || "").toString();
  const heure   = (data.heure   || "").toString();

  let title;
  if (type === "rdv")         title = "\u{1F4C5} Nouveau rendez-vous";
  else if (type === "manuel") title = "\u2795 Encaissement ajoute";
  else if (type === "cancel") title = "\u274C Annulation";
  else                        title = "\u2702\uFE0F Nouveau client dans la file";
  let body = nom + (service ? " \u2014 " + service : "");
  if (type === "rdv" && jour) body += "\n" + jour + (heure ? " a " + heure : "");

  const { ref, tokens } = await readAdminTokens();
  if (tokens.length === 0) return { ok: false, reason: "no_token", sent: 0 };

  const resp = await admin.messaging().sendEachForMulticast({
    tokens,
    data: { title, body, tag: type + "-" + (jour || String(Date.now())), url: "./index.html", kind: type, jour, heure },
    webpush: { headers: { Urgency: "high", TTL: "86400" } },
    android: { priority: "high" }
  });

  // Nettoie les jetons qui ne sont plus valides
  const dead = [];
  resp.responses.forEach((r, i) => {
    if (!r.success) {
      const c = r.error && r.error.code;
      if (c === "messaging/registration-token-not-registered" ||
          c === "messaging/invalid-registration-token" ||
          c === "messaging/invalid-argument") dead.push(tokens[i]);
    }
  });
  if (dead.length) { await ref.update({ tokens: admin.firestore.FieldValue.arrayRemove(...dead) }).catch(() => {}); }

  // Renvoie aussi le 1er code d'erreur éventuel (utile pour diagnostiquer)
  let firstError = null;
  resp.responses.forEach((r) => { if (!r.success && !firstError) firstError = r.error && r.error.code; });
  return { ok: resp.successCount > 0, sent: resp.successCount, failed: resp.failureCount, firstError };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const configured = admin.apps.length > 0;

  // ===== DIAGNOSTIC (ouvrir l'URL dans le navigateur) =====
  if (req.method === "GET") {
    // Test d'envoi réel : /api/notify?test=1
    const wantTest = req.query && (req.query.test === "1" || req.query.test === "true");
    if (wantTest) {
      if (!configured) return res.status(200).json({ diagnostic: true, configured: false, message: "\u274C Cle SERVICE_ACCOUNT manquante ou invalide dans Vercel." });
      try {
        const r = await sendToAdmin({ nom: "Test", service: "Notification de test", type: "file" });
        let msg;
        if (r.reason === "no_token") msg = "\u26A0\uFE0F Aucun telephone enregistre. Ouvre l'app en gerant et appuie sur \"Activer les alertes\".";
        else if (r.sent > 0) msg = "\u2705 Notification de test envoyee ! Regarde ton telephone.";
        else msg = "\u274C Envoi echoue (code: " + (r.firstError || "inconnu") + ").";
        return res.status(200).json({ diagnostic: true, configured: true, test_result: r, message: msg });
      } catch (e) {
        return res.status(200).json({ diagnostic: true, configured: true, error: String(e && e.message ? e.message : e), message: "\u274C Erreur pendant l'envoi de test (souvent = cle de compte de service incorrecte)." });
      }
    }
    // État simple
    let tokenCount = 0, readError = null;
    if (configured) {
      try { const { tokens } = await readAdminTokens(); tokenCount = tokens.length; }
      catch (e) { readError = String(e && e.message ? e.message : e); }
    }
    let message;
    if (!configured) message = "\u274C Cle SERVICE_ACCOUNT manquante ou invalide dans Vercel. Ajoute-la puis Redeploy.";
    else if (readError) message = "\u274C La cle est presente mais l'acces Firebase echoue (cle de compte de service incorrecte ?). Detail: " + readError;
    else if (tokenCount === 0) message = "\u26A0\uFE0F Cle OK, mais aucun telephone enregistre. Ouvre l'app en gerant -> \"Activer les alertes\".";
    else message = "\u2705 Tout est pret : cle OK et " + tokenCount + " telephone(s) enregistre(s). Teste avec ?test=1";
    return res.status(200).json({ diagnostic: true, configured, tokens: tokenCount, readError, message });
  }

  // ===== ENVOI RÉEL (appelé par l'application à chaque réservation) =====
  if (req.method !== "POST") return res.status(200).json({ ok: false, error: "method_not_allowed" });
  if (!configured) return res.status(200).json({ ok: false, error: "not_configured" });

  try {
    let data = req.body;
    if (typeof data === "string") { try { data = JSON.parse(data); } catch (e) { data = {}; } }
    const r = await sendToAdmin(data || {});
    return res.status(200).json(r);
  } catch (e) {
    return res.status(200).json({ ok: false, error: "server_error" });
  }
};
