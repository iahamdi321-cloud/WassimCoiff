/* =====================================================================
   WASSIM COIFF — Cloud Functions : notifications push (Firebase Cloud Messaging)
   ---------------------------------------------------------------------
   Envoie automatiquement une notification sur le(s) téléphone(s) de
   l'admin à chaque action d'un CLIENT :
     • nouvelle place dans la file / nouveau rendez-vous
     • annulation ou modification d'une réservation
     • nouvel avis
     • nouvelle inscription
   + le bouton « Envoyer une notification de test » de la cloche (collection pushTests).

   Les jetons FCM des téléphones admin sont dans  fcmTokens/admin.tokens
   (enregistrés par l'app quand l'admin appuie sur « Activer les alertes »).

   Déploiement (forfait Blaze nécessaire, gratuit à ce volume) :
     cd functions && npm install && cd ..
     firebase deploy --only functions --project wassim-coiff
   ===================================================================== */

const { setGlobalOptions } = require("firebase-functions/v2");
const { onDocumentWritten, onDocumentCreated } = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();
const db = getFirestore();

/* Limite le nombre d'instances (protège la facture en cas d'abus).
   Si le déploiement se plaint de la région, ajoutez  region: "europe-west1"
   (base Firestore en « eur3 ») ou "us-central1" (base en « nam5 »). */
setGlobalOptions({ maxInstances: 5 });

/* ---------- utilitaires ---------- */
const clip = (v, n) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, n);

/* "2026-09-24" -> "jeudi 24 septembre" */
function frDate(jour) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(jour || ""))) return "";
  const d = new Date(jour + "T12:00:00Z");
  try {
    return d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  } catch (e) { return jour; }
}

/* Rôle de l'auteur d'une écriture (champ _by = uid). null si inconnu ou bloqué. */
async function roleOf(uid) {
  if (!uid) return null;
  const snap = await db.doc("users/" + uid).get();
  if (!snap.exists) return null;
  const u = snap.data() || {};
  if (u.disabled === true) return null;
  return u.role === "admin" ? "admin" : "client";
}

/* Envoie un message à tous les téléphones admin enregistrés.
   Message "data only" : c'est sw.js (arrière-plan) ou index.html (premier plan)
   qui l'affiche, pour garder la même présentation partout. */
async function sendToAdmins(msg) {
  const ref = db.doc("fcmTokens/admin");
  const snap = await ref.get();
  let tokens = [];
  if (snap.exists) {
    const d = snap.data() || {};
    if (Array.isArray(d.tokens)) tokens = d.tokens;
    else if (d.token) tokens = [d.token];
  }
  tokens = [...new Set(tokens.filter((t) => typeof t === "string" && t))];
  if (!tokens.length) {
    logger.warn("Aucun téléphone admin enregistré (fcmTokens/admin vide). Activez les alertes dans l'app.");
    return { sent: 0, failed: 0 };
  }

  const data = {
    title: clip(msg.title, 120),
    body: String(msg.body || "").slice(0, 400),
    tag: clip(msg.tag || "wassim-" + Date.now(), 120),
    url: "./index.html",
    kind: clip(msg.kind, 20),
    jour: clip(msg.jour, 10),
    heure: clip(msg.heure, 5),
  };

  const resp = await getMessaging().sendEachForMulticast({
    tokens,
    data,
    webpush: { headers: { Urgency: "high", TTL: "86400" } },
    android: { priority: "high" },
  });

  // on retire seulement les jetons définitivement invalides (téléphone désinstallé, etc.)
  const dead = [];
  resp.responses.forEach((r, i) => {
    if (r.success) return;
    const code = r.error && r.error.code;
    logger.warn("Échec d'envoi FCM", { code, message: r.error && r.error.message });
    if (code === "messaging/registration-token-not-registered" ||
        code === "messaging/invalid-registration-token") dead.push(tokens[i]);
  });
  if (dead.length) {
    await ref.update({ tokens: FieldValue.arrayRemove(...dead) }).catch(() => {});
  }
  logger.info("Notification envoyée", { title: data.title, sent: resp.successCount, failed: resp.failureCount });
  return { sent: resp.successCount, failed: resp.failureCount };
}

/* ---------- 1) Réservations : création, annulation, modification par un client ---------- */
exports.notifReservation = onDocumentWritten("bookings/{id}", async (event) => {
  const before = event.data && event.data.before;
  const after = event.data && event.data.after;
  if (!after || !after.exists) return;                    // suppression : rien à signaler

  const b = after.data() || {};
  const prev = before && before.exists ? before.data() || {} : null;

  // Pas une nouvelle écriture "signée" (ex. réécriture technique) -> on ignore
  if (prev && prev._by === b._by && prev._at === b._at) return;

  // On ne prévient l'admin que pour les actions des CLIENTS (pas ses propres actions)
  if ((await roleOf(b._by)) !== "client") return;

  const isRdv = b.type === "rdv";
  let title, kind;
  if (!prev) {
    title = isRdv ? "📅 Nouveau rendez-vous" : "✂️ Nouveau client dans la file";
    kind = isRdv ? "rdv" : "file";
  } else if (b.statut === "annule" && prev.statut !== "annule") {
    title = isRdv ? "❌ Rendez-vous annulé" : "❌ Place annulée";
    kind = "cancel";
  } else {
    title = "✏️ Réservation modifiée";
    kind = isRdv ? "rdv" : "file";
  }

  let body = clip(b.clientNom || "Client", 80);
  if (b.nom_fr) body += " — " + clip(b.nom_fr, 80);
  if (isRdv && b.jour) body += "\n" + frDate(b.jour) + (b.heure ? " à " + b.heure : "");

  await sendToAdmins({ title, body, kind, jour: b.jour, heure: b.heure, tag: kind + "-" + event.params.id });
});

/* ---------- 2) Nouvel avis d'un client ---------- */
exports.notifAvis = onDocumentCreated("avis/{id}", async (event) => {
  const a = event.data && event.data.data();
  if (!a) return;
  if ((await roleOf(a._by)) !== "client") return;
  const note = Math.max(1, Math.min(5, parseInt(a.note, 10) || 0));
  let body = clip(a.nom || "Client", 80) + " — " + "★".repeat(note) + "☆".repeat(5 - note);
  if (a.texte) body += "\n" + clip(a.texte, 140);
  await sendToAdmins({ title: "⭐ Nouvel avis (" + note + "/5)", body, kind: "avis", tag: "avis-" + event.params.id });
});

/* ---------- 3) Nouvelle inscription d'un client ---------- */
exports.notifInscription = onDocumentCreated("users/{uid}", async (event) => {
  const u = event.data && event.data.data();
  if (!u) return;
  // uniquement les clients qui se sont inscrits eux-mêmes (pas un admin créé par un admin)
  if (u.role !== "client" || u.legacy === true || u._by !== event.params.uid) return;
  let body = clip(u.nom || "Client", 80);
  if (u.tel) body += " — " + clip(u.tel, 30);
  if (u.email) body += "\n" + clip(u.email, 120);
  await sendToAdmins({ title: "👤 Nouveau client inscrit", body, kind: "inscription", tag: "inscription-" + event.params.uid });
});

/* ---------- 4) Bouton « Tester les notifications » (cloche de l'admin) ---------- */
exports.notifTest = onDocumentCreated("pushTests/{id}", async (event) => {
  const snap = event.data;
  if (!snap) return;
  const t = snap.data() || {};
  try {
    if ((await roleOf(t.by)) === "admin") {
      await sendToAdmins({
        title: "🔔 Notification de test",
        body: "Les alertes Wassim Coiff fonctionnent sur ce téléphone ✅",
        kind: "test",
        tag: "test-" + event.params.id,
      });
    }
  } finally {
    await snap.ref.delete().catch(() => {});             // on ne garde pas les tests
  }
});
