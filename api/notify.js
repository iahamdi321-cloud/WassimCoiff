// api/notify.js — Fonction serverless Vercel (Firebase Cloud Messaging)
// Envoie une notification push au téléphone du gérant à chaque réservation.
//
// Variable d'environnement à définir dans Vercel (Settings -> Environment Variables) :
//   SERVICE_ACCOUNT  ->  colle ici TOUT le contenu du fichier .json du compte de service Firebase

const admin = require("firebase-admin");

// Initialise Firebase Admin une seule fois (Vercel réutilise l'instance entre les appels)
if (!admin.apps.length && process.env.SERVICE_ACCOUNT) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.SERVICE_ACCOUNT))
    });
  } catch (e) { /* clé invalide/mal collée : on renvoie "not_configured" plus bas */ }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(200).json({ ok: false, error: "method_not_allowed" });

  // Si la clé du compte de service n'est pas (encore) configurée, on ne plante pas :
  // l'app continue de fonctionner, seule la notif téléphone est ignorée.
  if (!admin.apps.length) {
    return res.status(200).json({ ok: false, error: "not_configured" });
  }

  try {
    let data = req.body;
    if (typeof data === "string") { try { data = JSON.parse(data); } catch (e) { data = {}; } }
    data = data || {};

    const nom     = (data.nom     || "Client").toString().slice(0, 80);
    const service = (data.service || "").toString().slice(0, 80);
    const type    = (data.type    || "file").toString();
    const jour    = (data.jour    || "").toString();
    const heure   = (data.heure   || "").toString();

    // Compose un message lisible selon le type de réservation
    let title;
    if (type === "rdv")         title = "\u{1F4C5} Nouveau rendez-vous";
    else if (type === "manuel") title = "\u2795 Encaissement ajoute";
    else if (type === "cancel") title = "\u274C Annulation";
    else                        title = "\u2702\uFE0F Nouveau client dans la file";
    let body = nom + (service ? " \u2014 " + service : "");
    if (type === "rdv" && jour) body += "\n" + jour + (heure ? " a " + heure : "");

    // Récupère les jetons du gérant (plusieurs appareils possibles)
    const ref = admin.firestore().doc("fcmTokens/admin");
    const snap = await ref.get();
    let tokens = [];
    if (snap.exists) {
      const d = snap.data();
      if (Array.isArray(d.tokens)) tokens = d.tokens;      // format multi-appareils
      else if (d.token) tokens = [d.token];                // ancien format éventuel
    }
    tokens = [...new Set(tokens)].filter(Boolean);
    if (tokens.length === 0) return res.status(200).json({ ok: false, reason: "no_token" });

    // data-only : c'est le service worker qui affiche la notif (évite le double affichage)
    const resp = await admin.messaging().sendEachForMulticast({
      tokens,
      data: {
        title: title,
        body: body,
        tag: type + "-" + (jour || String(Date.now())),
        url: "./index.html",
        kind: type,
        jour: jour,
        heure: heure
      },
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
    if (dead.length) {
      await ref.update({ tokens: admin.firestore.FieldValue.arrayRemove(...dead) }).catch(() => {});
    }

    return res.status(200).json({ ok: true, sent: resp.successCount, failed: resp.failureCount });
  } catch (e) {
    return res.status(200).json({ ok: false, error: "server_error" });
  }
};
