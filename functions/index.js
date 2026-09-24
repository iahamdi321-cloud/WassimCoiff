/* =====================================================================
   WASSIM COIFF — Cloud Functions : alertes INSTANTANÉES pour l'admin
   ---------------------------------------------------------------------
   Chaque action d'un client (place dans la file, rendez-vous, annulation,
   avis, inscription) crée un document dans « notifs » (la cloche de
   l'admin). Cette fonction l'envoie aussitôt en notification push sur
   le(s) téléphone(s) admin (jetons dans fcmTokens/admin).

   Sans ces fonctions, le robot GitHub (scripts/envoyer-rappels.mjs)
   envoie les mêmes alertes toutes les 15 minutes. Les deux utilisent la
   collection « pushLog » pour réserver chaque envoi : jamais de doublon,
   quelle que soit la solution qui passe en premier.

   Elle applique aussi, en quelques secondes, le mot de passe qu'un admin
   définit pour un client (collection « motsDePasse », effacée aussitôt).

   Déploiement (forfait Blaze nécessaire, gratuit à ce volume) :
     cd functions && npm install && cd ..
     firebase deploy --only functions --project wassim-coiff
   ===================================================================== */

const { setGlobalOptions } = require("firebase-functions/v2");
const { onDocumentCreated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const { getAuth } = require("firebase-admin/auth");

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
  try {
    return new Date(jour + "T12:00:00Z").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  } catch (e) { return jour; }
}

/* Rôle de l'auteur (champ _by = uid). null si inconnu ou bloqué. */
async function roleOf(uid) {
  if (!uid) return null;
  const snap = await db.doc("users/" + uid).get();
  if (!snap.exists) return null;
  const u = snap.data() || {};
  if (u.disabled === true) return null;
  return u.role === "admin" ? "admin" : "client";
}

/* Texte de l'alerte admin à partir d'un document « notifs »
   (même présentation que le robot GitHub). */
function messageAdmin(n) {
  const nom = clip(n.nom || "Client", 60), svc = clip(n.service_fr, 60);
  const quand = n.jour && n.heure ? `\n${frDate(n.jour)} à ${n.heure}` : "";
  const base = nom + (svc ? " — " + svc : "");
  switch (n.kind) {
    case "rdv":    return { title: "📅 Nouveau rendez-vous", body: base + quand };
    case "file":   return { title: "✂️ Nouveau client dans la file", body: base };
    case "cancel": return { title: n.heure ? "❌ Rendez-vous annulé" : "❌ Place annulée", body: base + quand };
    case "avis": {
      const note = Math.max(1, Math.min(5, parseInt(n.note, 10) || 0));
      return { title: `⭐ Nouvel avis (${note}/5)`, body: nom + " — " + "★".repeat(note) + "☆".repeat(5 - note) };
    }
    case "inscription": return { title: "👤 Nouveau client inscrit", body: nom + (n.tel ? " — " + clip(n.tel, 20) : "") };
    default: return null;
  }
}

/* Réserve un envoi dans pushLog (échoue si déjà fait par le robot ou une autre exécution). */
async function reserver(cle) {
  try {
    await db.collection("pushLog").doc(cle).create({
      cle, cible: "admin", par: "cloud-function",
      envoyeLe: FieldValue.serverTimestamp(), expireAt: new Date(Date.now() + 30 * 86400000),
    });
    return true;
  } catch (e) { return false; }
}

/* Envoie à tous les téléphones admin. Message "data only" : sw.js / index.html l'affichent. */
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
    logger.warn("Aucun téléphone admin enregistré (fcmTokens/admin vide). Dans l'app : 🔔 → Activer les alertes.");
    return { sent: 0, panne: false };
  }
  const resp = await getMessaging().sendEachForMulticast({
    tokens,
    data: {
      title: clip(msg.title, 120), body: String(msg.body || "").slice(0, 400),
      tag: clip(msg.tag || "wassim-" + Date.now(), 120), url: "./index.html",
      kind: clip(msg.kind, 20), jour: clip(msg.jour, 10), heure: clip(msg.heure, 5),
    },
    webpush: { headers: { Urgency: "high", TTL: "86400" } },
    android: { priority: "high" },
  });
  const dead = [];
  let panne = false;
  resp.responses.forEach((r, i) => {
    if (r.success) return;
    const code = r.error && r.error.code;
    logger.warn("Échec d'envoi FCM", { code, message: r.error && r.error.message });
    if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") dead.push(tokens[i]);
    else panne = true;
  });
  if (dead.length) await ref.update({ tokens: FieldValue.arrayRemove(...dead) }).catch(() => {});
  logger.info("Notification envoyée", { title: msg.title, sent: resp.successCount, failed: resp.failureCount });
  return { sent: resp.successCount, panne };
}

/* ---------- 1) Chaque action d'un client (cloche « notifs ») ---------- */
exports.notifAction = onDocumentCreated("notifs/{id}", async (event) => {
  const n = event.data && event.data.data();
  if (!n) return;
  if ((await roleOf(n._by)) !== "client") return;            // seules les actions des CLIENTS
  const m = messageAdmin(n);
  if (!m) return;
  const cle = "notif_" + event.params.id;
  if (!(await reserver(cle))) return;                          // déjà envoyé par le robot
  const r = await sendToAdmins({ ...m, kind: n.kind, jour: n.jour, heure: n.heure, tag: cle });
  if (!r.sent && r.panne) await db.collection("pushLog").doc(cle).delete().catch(() => {});   // le robot réessaiera
});

/* ---------- 2) Bouton « Envoyer une notification de test » (cloche de l'admin) ---------- */
exports.notifTest = onDocumentCreated("pushTests/{id}", async (event) => {
  const snap = event.data;
  if (!snap) return;
  const t = snap.data() || {};
  try {
    if ((await roleOf(t.by)) === "admin" && (await reserver("test_" + event.params.id))) {
      await sendToAdmins({
        title: "🔔 Notification de test",
        body: "Les alertes Wassim Coiff fonctionnent sur ce téléphone ✅",
        kind: "test", tag: "test-" + event.params.id,
      });
    }
  } finally {
    await snap.ref.delete().catch(() => {});                   // on ne garde pas les tests
  }
});

/* ---------- 3) Mot de passe défini par l'admin pour un CLIENT (onglet Comptes → ✏️) ---------- */
exports.motDePasse = onDocumentWritten("motsDePasse/{uid}", async (event) => {
  const after = event.data && event.data.after;
  if (!after || !after.exists) return;                         // document déjà effacé
  const x = after.data() || {};
  try {
    if (typeof x.pass === "string" && x.pass.length >= 6
        && (await roleOf(x.by)) === "admin" && (await roleOf(event.params.uid)) === "client") {
      await getAuth().updateUser(event.params.uid, { password: x.pass });
      logger.info("Mot de passe client mis à jour", { uid: event.params.uid });
    }
  } catch (e) {
    logger.warn("Mot de passe non appliqué", { code: e && e.code });
  } finally {
    await after.ref.delete().catch(() => {});                  // on ne garde jamais le mot de passe
  }
});
