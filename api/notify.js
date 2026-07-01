// api/notify.js — Fonction serverless Vercel
// Envoie une notification au téléphone du gérant (via un bot Telegram)
// à chaque nouvelle réservation. Les secrets restent dans les
// "Environment Variables" de Vercel, jamais dans le code du site.
//
// Variables d'environnement à définir dans Vercel (Settings -> Environment Variables) :
//   TELEGRAM_TOKEN    -> le jeton donné par @BotFather
//   TELEGRAM_CHAT_ID  -> l'identifiant de la conversation où recevoir les messages

module.exports = async (req, res) => {
  // On n'accepte que les envois (POST)
  if (req.method !== "POST") {
    return res.status(200).json({ ok: false, error: "method_not_allowed" });
  }

  try {
    // Récupère les infos envoyées par l'application
    // (req.body est déjà un objet si le Content-Type est JSON ; sinon on le lit)
    let data = req.body;
    if (typeof data === "string") {
      try { data = JSON.parse(data); } catch (e) { data = {}; }
    }
    data = data || {};

    const nom     = (data.nom     || "Client").toString().slice(0, 80);
    const service = (data.service || "").toString().slice(0, 80);
    const type    = (data.type    || "file").toString();
    const jour    = (data.jour    || "").toString();
    const heure   = (data.heure   || "").toString();

    const token  = process.env.TELEGRAM_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    // Si les secrets ne sont pas configurés, on ne plante pas :
    // l'app continue de fonctionner, seule la notif téléphone est ignorée.
    if (!token || !chatId) {
      return res.status(200).json({ ok: false, error: "not_configured" });
    }

    // Compose un message lisible selon le type de réservation
    let titre;
    if (type === "rdv")         titre = "\u{1F4C5} Nouveau rendez-vous";
    else if (type === "manuel") titre = "\u2795 Encaissement ajoute";
    else if (type === "cancel") titre = "\u274C Annulation";
    else                        titre = "\u2702\uFE0F Nouveau client dans la file";

    let texte = titre + "\n\u{1F464} " + nom;
    if (service) texte += "\n\u{1F488} " + service;
    if (type === "rdv" && jour) {
      texte += "\n\u{1F5D3}\uFE0F " + jour + (heure ? " a " + heure : "");
    }

    // Envoi au bot Telegram (fetch est natif sur Vercel / Node 18+)
    const url = "https://api.telegram.org/bot" + token + "/sendMessage";
    const tgRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: texte, disable_web_page_preview: true })
    });

    const tgJson = await tgRes.json().catch(() => ({}));
    return res.status(200).json({ ok: !!tgJson.ok });
  } catch (err) {
    // On renvoie toujours 200 pour ne jamais bloquer l'application côté client
    return res.status(200).json({ ok: false, error: "server_error" });
  }
};
