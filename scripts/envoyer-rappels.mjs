/* =====================================================================
   WASSIM COIFF — Robot des rappels (notifications push FCM)
   ---------------------------------------------------------------------
   Tourne sur GitHub Actions (gratuit) toutes les 15 minutes, même quand
   personne n'a l'application ouverte. Il utilise une clé de service
   Firebase rangée dans les secrets GitHub (jamais dans l'application).

   Il envoie :
     • au CLIENT, pour chaque rendez-vous (en attente ou validé) :
         - la veille, entre 18 h et 22 h  → « Rendez-vous demain à 10:30 »
         - environ 1 h avant               → « Rendez-vous à 10:30 »
       dans la langue choisie sur son téléphone (français ou arabe) ;
     • à l'ADMIN, un récapitulatif :
         - le matin (7 h – 11 h)  → « Aujourd'hui : 5 rendez-vous »
         - le soir  (19 h – 22 h) → « Demain : 3 rendez-vous »
     • (option ADMIN_INSTANT=1) à l'ADMIN, chaque nouvelle action d'un client
       (file, rendez-vous, annulation, avis, inscription) avec 15 à 30 min de
       délai. À utiliser SEULEMENT si les Cloud Functions ne sont pas
       déployées (sinon l'admin reçoit tout en double).

   Chaque envoi est noté dans la collection « pushLog » : relancer le robot
   plusieurs fois n'envoie jamais deux fois le même message.

   Test à blanc (n'envoie rien, affiche seulement) :
     DRY_RUN=1 FIREBASE_SERVICE_ACCOUNT="$(cat cle.json)" node envoyer-rappels.mjs
   ===================================================================== */

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

/* ---------------------------------------------------------------- */
/*  Réglages                                                         */
/* ---------------------------------------------------------------- */
const SALON         = "Wassim Coiff";
const TZ            = "Africa/Tunis";                 // heure de la Tunisie
const DRY_RUN       = process.env.DRY_RUN === "1";
const ADMIN_INSTANT = process.env.ADMIN_INSTANT === "1";
const LOG_TTL_JOURS = 30;                             // durée de conservation des traces d'envoi

/* ---------------------------------------------------------------- */
/*  Connexion Firebase (clé de service)                              */
/* ---------------------------------------------------------------- */
const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!raw) {
  // Pas d'erreur rouge (sinon GitHub enverrait un e-mail toutes les 15 min) : un simple avertissement.
  console.log("::warning::Secret FIREBASE_SERVICE_ACCOUNT absent : ajoutez-le dans Settings → Secrets and variables → Actions.");
  process.exit(0);
}
let cle;
try { cle = JSON.parse(raw); }
catch (e) { console.error("✗ FIREBASE_SERVICE_ACCOUNT n'est pas un JSON valide (collez TOUT le fichier .json)."); process.exit(1); }
initializeApp({ credential: cert(cle) });
const db  = getFirestore();
const fcm = getMessaging();

/* ---------------------------------------------------------------- */
/*  Heure de Tunis                                                   */
/* ---------------------------------------------------------------- */
const NOW = process.env.FAKE_NOW ? new Date(process.env.FAKE_NOW) : new Date();   // FAKE_NOW : tests uniquement
function local(d) {
  const p = {};
  new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).forEach((x) => { p[x.type] = x.value; });
  return { date: `${p.year}-${p.month}-${p.day}`, h: +p.hour, m: +p.minute };
}
const L          = local(NOW);
const AUJOURDHUI = L.date;
const DEMAIN     = local(new Date(NOW.getTime() + 86400000)).date;
const MIN_NOW    = L.h * 60 + L.m;
const hm2min     = (hm) => { const [h, m] = String(hm || "").split(":").map((n) => parseInt(n, 10)); return (h * 60 + m) || 0; };

console.log(`— Rappels ${SALON} — ${AUJOURDHUI} ${String(L.h).padStart(2, "0")}:${String(L.m).padStart(2, "0")} (Tunis)` +
            `${DRY_RUN ? " — TEST À BLANC" : ""}${ADMIN_INSTANT ? " — alertes admin actives" : ""}`);

/* ---------------------------------------------------------------- */
/*  Lecture des rendez-vous d'aujourd'hui et de demain               */
/* ---------------------------------------------------------------- */
const snapRdv = await db.collection("bookings").where("jour", "in", [AUJOURDHUI, DEMAIN]).get();
const rdvs = snapRdv.docs.map((d) => d.data())
  .filter((b) => b && b.type === "rdv" && (b.statut === "attente" || b.statut === "valide") && /^\d{2}:\d{2}$/.test(b.heure || ""))
  .sort((a, b) => (a.jour + a.heure).localeCompare(b.jour + b.heure));
console.log(`  ${rdvs.length} rendez-vous actifs aujourd'hui / demain.`);

/* ---------------------------------------------------------------- */
/*  Textes (français / arabe)                                        */
/* ---------------------------------------------------------------- */
const TXT = {
  j1: {
    fr: (b) => ({ title: `⏰ Rendez-vous demain à ${b.heure}`,
                  body: `${SALON} — ${b.nom_fr || "votre prestation"}. Un empêchement ? Annulez dans l'application.` }),
    ar: (b) => ({ title: `⏰ موعدك غدًا على الساعة ${b.heure}`,
                  body: `${SALON} — ${b.nom_ar || b.nom_fr || ""}. إذا لم تتمكن من الحضور، ألغِ الموعد من التطبيق.` }),
  },
  h1: {
    fr: (b) => ({ title: `✂️ Rendez-vous à ${b.heure}`,
                  body: `C'est bientôt chez ${SALON} — ${b.nom_fr || "votre prestation"}. À tout à l'heure !` }),
    ar: (b) => ({ title: `✂️ موعدك على الساعة ${b.heure}`,
                  body: `قريبًا في ${SALON} — ${b.nom_ar || b.nom_fr || ""}. في انتظارك!` }),
  },
};
const clip = (v, n) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, n);

/* ---------------------------------------------------------------- */
/*  Liste des messages à envoyer                                     */
/*  job = { cle, cible: "admin" | {uid}, kind, jour, heure, ttl, texte(lang) }  */
/* ---------------------------------------------------------------- */
const jobs = [];

/* 1) Rappels aux clients (seulement les rendez-vous pris par un client inscrit) */
for (const b of rdvs) {
  if (!b.userId) continue;
  const recent = (min) => (b.createdAt || 0) > NOW.getTime() - min * 60000;   // réservé à l'instant ? inutile de rappeler
  if (b.jour === DEMAIN && L.h >= 18 && L.h < 22 && !recent(180)) {
    jobs.push({ cle: `rdv_j1_${b.id}`, cible: { uid: b.userId }, kind: "rappel", jour: b.jour, heure: b.heure,
                ttl: 43200, texte: (lang) => TXT.j1[lang](b) });
  }
  const avant = hm2min(b.heure) - MIN_NOW;
  if (b.jour === AUJOURDHUI && avant > 0 && avant <= 75 && !recent(30)) {
    jobs.push({ cle: `rdv_h1_${b.id}`, cible: { uid: b.userId }, kind: "rappel", jour: b.jour, heure: b.heure,
                ttl: Math.max(600, avant * 60), texte: (lang) => TXT.h1[lang](b) });
  }
}

/* 2) Récapitulatifs pour l'admin (tous les rendez-vous, y compris ceux ajoutés par l'admin) */
const recap = (jour) => {
  const liste = rdvs.filter((b) => b.jour === jour);
  const noms = liste.slice(0, 6).map((b) => `${b.heure} ${clip(b.clientNom, 20)}`).join(" · ");
  return { n: liste.length, detail: noms + (liste.length > 6 ? " …" : "") };
};
if (L.h >= 7 && L.h < 11) {
  const r = recap(AUJOURDHUI);
  if (r.n) jobs.push({ cle: `adm_j0_${AUJOURDHUI}`, cible: "admin", kind: "rdv", jour: AUJOURDHUI, heure: "", ttl: 21600,
                       texte: () => ({ title: `📋 Aujourd'hui : ${r.n} rendez-vous`, body: r.detail }) });
}
if (L.h >= 19 && L.h < 22) {
  const r = recap(DEMAIN);
  if (r.n) jobs.push({ cle: `adm_j1_${DEMAIN}`, cible: "admin", kind: "rdv", jour: DEMAIN, heure: "", ttl: 43200,
                       texte: () => ({ title: `📋 Demain : ${r.n} rendez-vous`, body: r.detail }) });
}

/* 3) Option : alertes admin sans Cloud Functions (à partir de la cloche « notifs ») */
const roles = new Map();
async function roleOf(uid) {
  if (!uid) return null;
  if (roles.has(uid)) return roles.get(uid);
  const s = await db.doc("users/" + uid).get();
  const u = s.exists ? s.data() : null;
  const r = !u || u.disabled === true ? null : (u.role === "admin" ? "admin" : "client");
  roles.set(uid, r);
  return r;
}
if (ADMIN_INSTANT) {
  const snapN = await db.collection("notifs").where("ts", ">=", NOW.getTime() - 3 * 3600000).get();
  for (const d of snapN.docs) {
    const n = d.data() || {};
    if ((await roleOf(n._by)) !== "client") continue;
    const nom = clip(n.nom || "Client", 60), svc = clip(n.service_fr, 60);
    let title, body = nom + (svc ? " — " + svc : "");
    switch (n.kind) {
      case "rdv":         title = "📅 Nouveau rendez-vous"; if (n.jour) body += `\n${n.jour}${n.heure ? " à " + n.heure : ""}`; break;
      case "file":        title = "✂️ Nouveau client dans la file"; break;
      case "cancel":      title = n.heure ? "❌ Rendez-vous annulé" : "❌ Place annulée"; break;
      case "avis":        title = `⭐ Nouvel avis (${Math.max(1, Math.min(5, parseInt(n.note, 10) || 0))}/5)`; body = nom; break;
      case "inscription": title = "👤 Nouveau client inscrit"; body = nom + (n.tel ? " — " + clip(n.tel, 20) : ""); break;
      default: continue;
    }
    jobs.push({ cle: `notif_${d.id}`, cible: "admin", kind: n.kind, jour: n.jour || "", heure: n.heure || "", ttl: 86400,
                texte: () => ({ title, body }) });
  }
}

/* ---------------------------------------------------------------- */
/*  Téléphones (jetons FCM)                                          */
/* ---------------------------------------------------------------- */
async function appareilsAdmin() {
  const s = await db.doc("fcmTokens/admin").get();
  const d = s.exists ? s.data() || {} : {};
  const t = Array.isArray(d.tokens) ? d.tokens : (d.token ? [d.token] : []);
  return [...new Set(t.filter((x) => typeof x === "string" && x))].map((token) => ({ token, lang: "fr", admin: true }));
}
async function appareilsClient(uid) {
  const s = await db.collection("pushTokens").where("userId", "==", uid).get();
  const out = [];
  for (const d of s.docs) {
    const x = d.data() || {};
    if (!x.token) continue;
    // Même téléphone repris par un autre compte ? On ne garde que le rattachement le plus récent.
    const memes = await db.collection("pushTokens").where("token", "==", x.token).get();
    const plusRecent = memes.docs.some((o) => o.id !== d.id && (o.data().updatedAt || 0) > (x.updatedAt || 0));
    if (plusRecent) { if (!DRY_RUN) await d.ref.delete().catch(() => {}); continue; }
    out.push({ token: x.token, lang: x.lang === "ar" ? "ar" : "fr", ref: d.ref });
  }
  return out;
}

/* ---------------------------------------------------------------- */
/*  Envoi                                                            */
/* ---------------------------------------------------------------- */
let envoyes = 0, dejaFaits = 0, sansAppareil = 0, jetonsMorts = 0;

for (const job of jobs) {
  const refLog = db.collection("pushLog").doc(job.cle);
  if ((await refLog.get()).exists) { dejaFaits++; continue; }

  const appareils = job.cible === "admin" ? await appareilsAdmin() : await appareilsClient(job.cible.uid);
  if (!appareils.length) { sansAppareil++; continue; }      // pas de trace : réessayé au prochain passage

  if (DRY_RUN) {
    const t = job.texte(appareils[0].lang);
    console.log(`  [test] ${job.cible === "admin" ? "admin" : job.cible.uid} ← ${t.title} | ${t.body.replace(/\n/g, " / ")} (${appareils.length} appareil(s))`);
    continue;
  }

  // On « réserve » l'envoi (create échoue si un autre passage l'a déjà fait) : jamais de doublon.
  try {
    await refLog.create({ cle: job.cle, cible: job.cible === "admin" ? "admin" : job.cible.uid,
                          envoyeLe: FieldValue.serverTimestamp(), expireAt: new Date(NOW.getTime() + LOG_TTL_JOURS * 86400000) });
  } catch (e) { dejaFaits++; continue; }

  let ok = 0, erreur = null;
  for (const lang of ["fr", "ar"]) {
    const lot = appareils.filter((a) => a.lang === lang);
    if (!lot.length) continue;
    const t = job.texte(lang);
    const res = await fcm.sendEachForMulticast({
      tokens: lot.map((a) => a.token),
      data: { title: clip(t.title, 120), body: String(t.body).slice(0, 400), tag: job.cle, url: "./index.html",
              kind: job.kind, jour: job.jour || "", heure: job.heure || "" },
      webpush: { headers: { Urgency: "high", TTL: String(job.ttl || 86400) } },
      android: { priority: "high" },
    });
    ok += res.successCount;
    await Promise.all(res.responses.map(async (r, i) => {
      if (r.success) return;
      const code = (r.error && r.error.code) || "";
      if (code.includes("registration-token-not-registered") || code.includes("invalid-registration-token")) {
        jetonsMorts++;
        const a = lot[i];
        if (a.admin) await db.doc("fcmTokens/admin").update({ tokens: FieldValue.arrayRemove(a.token) }).catch(() => {});
        else if (a.ref) await a.ref.delete().catch(() => {});
      } else { erreur = code || "inconnue"; console.warn(`    ! échec d'envoi (${job.cle}) : ${code}`); }
    }));
  }
  envoyes += ok;
  // Rien n'est parti à cause d'une panne (pas d'un jeton mort) : on libère pour réessayer au prochain passage.
  if (!ok && erreur) await refLog.delete().catch(() => {});
}

/* ---------------------------------------------------------------- */
/*  Ménage des anciennes traces                                      */
/* ---------------------------------------------------------------- */
if (!DRY_RUN) {
  const vieux = await db.collection("pushLog").where("expireAt", "<", NOW).limit(200).get();
  await Promise.all(vieux.docs.map((d) => d.ref.delete().catch(() => {})));
}

console.log(`✓ Terminé — ${jobs.length} message(s) prévu(s), ${envoyes} notification(s) envoyée(s), ` +
            `${dejaFaits} déjà envoyé(s), ${sansAppareil} sans téléphone enregistré, ${jetonsMorts} jeton(s) obsolète(s) supprimé(s).`);
process.exit(0);
