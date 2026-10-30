/* ============================================================================
   InvestPlus — client d'API
   Chargé APRÈS le script principal de index.html : il remplace les fonctions
   "de démonstration" par des appels au serveur (backend Node.js).
   Le serveur est la seule source de vérité : soldes, dépôts, investissements,
   gains, affiliation et droits administrateur ne sont jamais décidés ici.
   ============================================================================ */
(function () {
  'use strict';

  const TOKEN_KEY = 'ip_token';
  let token = null;
  try { token = localStorage.getItem(TOKEN_KEY); } catch (e) { /* stockage indisponible */ }

  const $ = (id) => document.getElementById(id);
  const tr = (fr, en) => (state.lang === 'fr' ? fr : en);
  const fmt = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fdate = (iso) => { try { return new Date(iso).toLocaleString(); } catch (e) { return ''; } };

  function setToken(t) {
    token = t;
    try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
  }

  /* Ignore les clics répétés pendant qu'une action est en cours (évite les doubles dépôts / doubles investissements) */
  function guard(fn) {
    let busy = false;
    return async function () {
      if (busy) return;
      busy = true;
      try { return await fn.apply(this, arguments); } finally { busy = false; }
    };
  }

  async function api(path, opts) {
    const { method = 'GET', body } = opts || {};
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (e) {
      const err = new Error(tr('Serveur injoignable. Vérifiez votre connexion.', 'Server unreachable. Check your connection.'));
      err.status = 0;
      throw err;
    }
    let data = {};
    try { data = await res.json(); } catch (e) { /* réponse vide */ }
    if (!res.ok) {
      if (res.status === 401 && token && path.indexOf('/api/auth/') !== 0) sessionExpired();
      const err = new Error(data.error || tr('Une erreur est survenue', 'Something went wrong'));
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  /* ---------- Session ---------- */
  let rawHistory = [];
  let adminData = null;
  let chatHistory = [];
  let lastSync = 0;

  function clearSession() {
    setToken(null);
    rawHistory = []; adminData = null; chatHistory = [];
    state.balance = 0; state.history = []; state.affiliates = [];
    Object.assign(state.user, { nom: '', prenom: '', email: '', phone: '', country: '', numbers: [], affiliateCode: '' });
    isAdminMode = false;
    chatStarted = false;
    const box = $('chatMessages'); if (box) box.innerHTML = '';
    ['loginPass', 'suPass', 'pfPass', 'pfCurrentPass', 'depositPin'].forEach((id) => { const el = $(id); if (el) el.value = ''; });
  }
  function sessionExpired() {
    clearSession();
    state.screenStack = ['screen-welcome'];
    showScreen('screen-welcome');
    toast(tr('Session expirée, reconnectez-vous', 'Session expired, please log in again'));
  }

  /* ---------- Libellés de l'historique (calculés ici pour suivre la langue) ---------- */
  const OP_NAMES = { yas: 'Mixx by Yas', moov: 'Moov Money (Flooz)' };
  const domLabel = (key) => (key ? (i18n[state.lang]['dom_' + (key === 'crypto' ? 'cryptoname' : key)] || key) : '');
  function labelFor(it) {
    const fr = state.lang === 'fr';
    const op = OP_NAMES[it.operator] || it.operator || '';
    switch (it.type) {
      case 'deposit':
        return (fr ? 'Dépôt' : 'Deposit') + (op ? ' — ' + op : '') + (it.ref ? ' (' + it.ref + ')' : '') +
          (it.status === 'pending' ? (fr ? ' — en attente de confirmation' : ' — pending confirmation') : '');
      case 'invest': {
        const u = it.units || 0;
        return (fr ? 'Investissement — ' : 'Investment — ') + domLabel(it.domain) + ' (' + u + ' ' + (fr ? (u > 1 ? 'unités' : 'unité') : (u > 1 ? 'units' : 'unit')) + ')';
      }
      case 'payout': return (fr ? 'Gain — ' : 'Earnings — ') + domLabel(it.domain);
      case 'commission': return fr ? "Commission d'affiliation" : 'Affiliate commission';
      case 'withdraw': return (fr ? 'Retrait' : 'Withdrawal') + (it.ref ? ' (' + it.ref + ')' : '');
      case 'refund': return fr ? 'Remboursement de retrait' : 'Withdrawal refund';
      default: return it.type;
    }
  }
  function remapHistory() {
    state.history = rawHistory.map((it) => ({
      type: ['payout', 'commission', 'refund'].indexOf(it.type) >= 0 ? 'gain' : it.type,
      label: labelFor(it),
      date: new Date(it.date).toLocaleDateString(),
      amount: Math.abs(it.amount),
      sign: it.amount >= 0 ? 1 : -1
    }));
  }

  /* ---------- Synchronisation avec le serveur (utilisateur) ---------- */
  function applyUser(u) {
    Object.assign(state.user, { nom: u.nom, prenom: u.prenom, email: u.email || '', phone: u.phone, country: u.country || '', numbers: u.numbers, affiliateCode: u.referralCode });
    state.balance = u.balance;
    $('pfNom').value = u.nom; $('pfPrenom').value = u.prenom; $('pfPhone').value = u.phone;
  }
  function refreshViews() {
    $('balanceVal').textContent = fmt(state.balance) + ' FCFA';
    buildDomains(); buildHistory(); buildInvestments(); buildAffiliates();
  }
  async function syncUser() {
    lastSync = Date.now();
    const r = await Promise.all([api('/api/me'), api('/api/history'), api('/api/affiliates')]);
    applyUser(r[0].user);
    rawHistory = r[1].items;
    state.balance = r[1].balance;
    state.affiliates = r[2].items;
    remapHistory();
    refreshViews();
  }

  async function enterApp() {
    const me = await api('/api/me');
    if (me.user.role === 'admin') {
      isAdminMode = true;
      await renderAdminAccounts();
      showScreen('screen-admin');
    } else {
      isAdminMode = false;
      await syncUser();
      showScreen('screen-home');
    }
  }

  /* ---------- Connexion / inscription / déconnexion ---------- */
  window.doLogin = guard(async function () {
    const phoneMode = $('loginPhoneField').style.display !== 'none';
    const identifier = (phoneMode ? $('loginPhone') : $('loginEmail')).value.trim();
    const password = $('loginPass').value;
    if (!identifier || !password) { toast(tr('Veuillez remplir tous les champs', 'Please fill in all fields')); return; }
    try {
      const r = await api('/api/auth/login', { method: 'POST', body: { identifier, password } });
      setToken(r.token);
      $('loginPass').value = '';
      await enterApp();
      toast(r.user.role === 'admin' ? tr("Connecté en tant qu'administrateur", 'Logged in as administrator') : tr('Connexion réussie', 'Logged in successfully'));
    } catch (e) { toast(e.message); }
  });

  window.doSignup = guard(async function () {
    const val = (id) => $(id).value.trim();
    const body = {
      nom: val('suNom'), prenom: val('suPrenom'), email: val('suEmail'), phone: val('suPhone'),
      country: $('suCountry').value, password: $('suPass').value, referralCode: val('suRef'),
      extraNumbers: Array.prototype.map.call(document.querySelectorAll('#extraNumbers input'), (i) => i.value.trim()).filter(Boolean)
    };
    if (!body.nom || !body.prenom || !body.email || !body.phone || !body.password) {
      toast(tr('Veuillez remplir tous les champs obligatoires', 'Please fill in all required fields')); return;
    }
    try {
      const r = await api('/api/auth/register', { method: 'POST', body });
      setToken(r.token);
      $('suPass').value = '';
      await enterApp();
      toast(tr('Compte créé avec succès', 'Account created successfully'));
    } catch (e) { toast(e.message); }
  });

  const _logout = window.logout;
  const _adminLogout = window.adminLogout;
  window.logout = function () { clearSession(); _logout(); };
  window.adminLogout = function () { clearSession(); _adminLogout(); };

  window.saveProfile = guard(async function () {
    const body = { nom: $('pfNom').value.trim(), prenom: $('pfPrenom').value.trim(), phone: $('pfPhone').value.trim() };
    if ($('pfPass').value) { body.password = $('pfPass').value; body.currentPassword = $('pfCurrentPass').value; }
    try {
      const r = await api('/api/me', { method: 'PUT', body });
      if (r.token) setToken(r.token);
      $('pfPass').value = ''; $('pfCurrentPass').value = '';
      await syncUser();
      closeProfile();
      toast(tr('Profil mis à jour', 'Profile updated'));
    } catch (e) { toast(e.message); }
  });

  /* ---------- Dépôt (le code secret mobile money ne quitte JAMAIS le téléphone : il n'est pas envoyé au serveur) ---------- */
  window.doDeposit = guard(async function () {
    const amt = Number($('depositAmount').value);
    const numero = $('depositNumber').value.trim();
    const pin = $('depositPin').value.trim();
    if (!Number.isInteger(amt) || amt <= 0) { toast(tr('Entrez un montant entier valide (en FCFA)', 'Enter a valid whole amount (FCFA)')); return; }
    if (!numero) { toast(tr('Entrez le numéro à utiliser pour le dépôt', 'Enter the number to use for the deposit')); return; }
    if (!pin) { toast(tr('Entrez votre code secret mobile money', 'Enter your mobile money secret code')); return; }
    const op = OPERATORS[selectedOperator];
    try {
      const r = await api('/api/deposits', { method: 'POST', body: { operator: selectedOperator, amount: amt, number: numero } });
      const ussd = op.buildUssd(amt, numero, pin);
      $('depositAmount').value = ''; $('depositPin').value = '';
      toast(tr('Référence ' + r.reference + ' — votre solde sera crédité après confirmation', 'Reference ' + r.reference + ' — your balance will be credited after confirmation'));
      await syncUser();
      goHome();
      window.location.href = 'tel:' + ussd.replace('#', '%23');
    } catch (e) { toast(e.message); }
  });

  /* ---------- Investissement ---------- */
  window.confirmInvestment = guard(async function () {
    if (!selectedDomain) return;
    try {
      await api('/api/investments', { method: 'POST', body: { domain: selectedDomain.key, units: selectedUnits } });
      await syncUser();
      toast(i18n[state.lang].invest_success);
      showScreen('screen-invest');
    } catch (e) {
      if (e.data && e.data.code === 'insufficient_balance') {
        const missing = Math.ceil(e.data.needed - e.data.balance);
        toast(tr('Solde insuffisant : il manque ' + fmt(missing) + ' FCFA. Faites d\'abord un dépôt.', 'Insufficient balance: ' + fmt(missing) + ' FCFA missing. Please make a deposit first.'));
        openDepositScreen();
        $('depositAmount').value = missing;
      } else { toast(e.message); }
    }
  });

  /* ---------- Assistance ---------- */
  window.sendSupportMessage = async function () {
    const input = $('chatInput');
    const q = input.value.trim();
    if (!q) return;
    ensureChatIntro();
    addChatMessage(q, 'user');
    input.value = '';
    chatHistory.push({ role: 'user', content: q });
    if (chatHistory.length > 20) chatHistory = chatHistory.slice(-20);
    const loading = addChatMessage(tr("L'assistant écrit...", 'Assistant is typing...'), 'bot loading');
    try {
      const r = await api('/api/support/ai', { method: 'POST', body: { messages: chatHistory } });
      loading.remove();
      addChatMessage(r.reply, 'bot');
      chatHistory.push({ role: 'assistant', content: r.reply });
    } catch (e) {
      loading.remove();
      chatHistory.pop();
      addChatMessage((e.status === 502 || e.status === 503)
        ? tr("L'assistant n'est pas disponible pour le moment. Utilisez l'onglet « Question sur mon compte » ou contactez-nous par WhatsApp.", 'The assistant is not available right now. Use the "Question about my account" tab or contact us on WhatsApp.')
        : e.message, 'bot');
    }
  };

  window.sendMoneyRequest = guard(async function () {
    const subject = $('moneySubject').value.trim();
    const message = $('moneyMessage').value.trim();
    if (!subject || !message) { toast(tr('Veuillez remplir le sujet et le message', 'Please fill in the subject and message')); return; }
    try {
      const r = await api('/api/support/money', { method: 'POST', body: { subject, message } });
      $('moneySubject').value = ''; $('moneyMessage').value = '';
      toast(r.emailed ? tr('Message envoyé à notre équipe par email', 'Message sent to our team by email')
                      : tr('Message enregistré, notre équipe vous répondra', 'Message saved, our team will get back to you'));
    } catch (e) { toast(e.message); }
  });

  /* ---------- Affiliation : les filleuls arrivent via le code de parrainage saisi à l'inscription ---------- */
  document.querySelectorAll('[onclick="toggleAddAffiliateForm()"]').forEach((el) => { el.style.display = 'none'; });
  if ($('addAffiliateForm')) $('addAffiliateForm').style.display = 'none';
  window.toggleAddAffiliateForm = function () {};
  window.addAffiliate = function () {};

  /* ---------- Administrateur ---------- */
  const style = document.createElement('style');
  style.textContent = '.adm-sec{margin:16px 20px 8px;font-size:13px;font-weight:700;color:var(--text)}' +
    '.adm-card{background:#fff;border:1px solid #F0EDFA;border-radius:16px;padding:14px 16px;margin:0 20px 10px}' +
    '.adm-card .who{font-size:13.5px;font-weight:700}.adm-card .meta{font-size:11.5px;color:var(--muted);margin-top:2px;white-space:pre-wrap;word-break:break-word}' +
    '.adm-card .row{display:flex;justify-content:space-between;align-items:center;gap:10px}' +
    '.adm-act{display:flex;gap:8px;margin-top:10px}.adm-btn{padding:8px 14px;border-radius:10px;font-size:12px;font-weight:600;color:#fff;background:var(--accent)}' +
    '.adm-btn.no{background:var(--danger)}.adm-empty{margin:0 20px 10px;font-size:12px;color:var(--muted)}';
  document.head.appendChild(style);

  function section(title, count, bodyHtml, emptyText) {
    return '<div class="adm-sec">' + esc(title) + ' (' + count + ')</div>' + (count ? bodyHtml : '<div class="adm-empty">' + esc(emptyText) + '</div>');
  }

  window.renderAdminAccounts = async function (refetch) {
    if (refetch !== false || !adminData) {
      try { adminData = await api('/api/admin/overview'); } catch (e) { toast(e.message); return; }
    }
    const d = adminData;
    const q = (($('adminSearch') && $('adminSearch').value) || '').toLowerCase();

    const deposits = d.deposits.map((x) =>
      '<div class="adm-card"><div class="row"><div><div class="who">' + esc(x.prenom + ' ' + x.nom) + '</div>' +
      '<div class="meta">' + esc(x.operator) + ' · ' + esc(x.number) + ' · ' + esc(x.reference) + '\n' + esc(fdate(x.date)) + '</div></div>' +
      '<div class="who" style="color:var(--violet)">' + fmt(x.amount) + ' FCFA</div></div>' +
      '<div class="adm-act"><button class="adm-btn" onclick="adminAction(\'deposits\',\'confirm\',' + Number(x.id) + ')">Confirmer reçu</button>' +
      '<button class="adm-btn no" onclick="adminAction(\'deposits\',\'reject\',' + Number(x.id) + ')">Rejeter</button></div></div>').join('');

    const withdrawals = d.withdrawals.map((x) =>
      '<div class="adm-card"><div class="row"><div><div class="who">' + esc(x.prenom + ' ' + x.nom) + '</div>' +
      '<div class="meta">Envoyer vers ' + esc(x.number) + '\n' + esc(fdate(x.date)) + '</div></div>' +
      '<div class="who" style="color:var(--violet)">' + fmt(x.amount) + ' FCFA</div></div>' +
      '<div class="adm-act"><button class="adm-btn" onclick="adminAction(\'withdrawals\',\'paid\',' + Number(x.id) + ')">Marquer payé</button>' +
      '<button class="adm-btn no" onclick="adminAction(\'withdrawals\',\'reject\',' + Number(x.id) + ')">Rejeter (rembourser)</button></div></div>').join('');

    const tickets = d.tickets.map((x) =>
      '<div class="adm-card"><div class="who">' + esc(x.subject) + '</div>' +
      '<div class="meta">' + esc(x.prenom + ' ' + x.nom) + ' · ' + esc(x.phone) + (x.email ? ' · ' + esc(x.email) : '') + ' · ' + esc(fdate(x.date)) + (x.emailed ? ' · ✉️ envoyé' : '') + '</div>' +
      '<div class="meta" style="color:var(--text);margin-top:6px">' + esc(x.message) + '</div></div>').join('');

    const users = d.users.filter((u) => (u.nom + ' ' + u.prenom + ' ' + (u.email || '') + ' ' + u.phone).toLowerCase().indexOf(q) >= 0);
    const accounts = users.map((u) =>
      '<div class="adm-card"><div class="row"><div><div class="who">' + esc(u.prenom + ' ' + u.nom) + '</div>' +
      '<div class="meta">' + esc(u.email || '') + ' · ' + esc(u.phone) + '</div></div>' +
      '<div class="who" style="color:var(--violet)">' + fmt(u.balance) + ' FCFA</div></div></div>').join('');

    $('adminAccountsList').innerHTML =
      section('Dépôts à confirmer', d.deposits.length, deposits, 'Aucun dépôt en attente') +
      section('Retraits à payer', d.withdrawals.length, withdrawals, 'Aucun retrait en attente') +
      section('Messages d\'assistance', d.tickets.length, tickets, 'Aucun message') +
      section('Comptes', users.length, accounts, 'Aucun compte trouvé');
  };

  window.adminAction = async function (kind, action, id) {
    const ask = { confirm: "Confirmez-vous avoir bien reçu cet argent ? Le solde de l'utilisateur sera crédité.", reject: 'Rejeter cette demande ?', paid: "Confirmez-vous avoir envoyé l'argent à cette personne ?" };
    if (!window.confirm(ask[action])) return;
    try { await api('/api/admin/' + kind + '/' + id + '/' + action, { method: 'POST' }); toast('OK'); }
    catch (e) { toast(e.message); }
    await renderAdminAccounts();
  };

  window.renderManagementDashboard = async function () {
    let s;
    try { s = await api('/api/admin/stats'); } catch (e) { toast(e.message); return; }
    $('managementTotal').innerHTML =
      '<div><div class="lbl">Total investi (tous domaines)</div><div class="val">' + fmt(s.totalFcfa) + ' FCFA</div></div>' +
      '<div style="text-align:right;"><div class="lbl">Parts totales (× 500 FCFA)</div><div class="val">' + fmt(s.totalUnits) + '</div></div>';
    $('managementList').innerHTML = s.domains.map((d) => {
      const meta = domains.find((x) => x.key === d.key) || { ic: '•', file: '' };
      return '<div class="mgmt-card"><div class="mgmt-card-head">' +
        '<div class="domain-icon"><img src="images/icons/' + esc(meta.file) + '" alt="" onerror="this.parentElement.textContent=\'' + meta.ic + '\'"></div>' +
        '<div><div class="name">' + esc(domLabel(d.key)) + '</div><div class="sub">' + d.units + ' part' + (d.units > 1 ? 's' : '') + ' · ' + d.investors + ' investisseur' + (d.investors > 1 ? 's' : '') + '</div></div></div>' +
        '<div class="mgmt-row"><span>Total investi</span><b>' + fmt(d.totalFcfa) + ' FCFA</b></div>' +
        '<div class="mgmt-calc"><input type="number" min="1" id="mgmtRevenue-' + d.key + '" placeholder="Revenu à répartir (ex : 5000)">' +
        '<button onclick="calcPayout(\'' + d.key + '\',' + d.units + ')">Calculer</button>' +
        '<button style="background:#1B1830" onclick="distributePayout(\'' + d.key + '\',' + d.units + ')">Distribuer</button></div>' +
        '<div class="mgmt-result" id="mgmtResult-' + d.key + '"></div></div>';
    }).join('');
  };

  window.distributePayout = guard(async function (key, parts) {
    const revenue = parseFloat($('mgmtRevenue-' + key).value);
    const out = $('mgmtResult-' + key);
    if (!revenue || revenue <= 0) { out.style.color = 'var(--danger)'; out.textContent = 'Entrez un montant valide'; return; }
    if (!parts) { out.style.color = 'var(--danger)'; out.textContent = 'Aucun investisseur dans ce domaine'; return; }
    const perPart = revenue / parts;
    if (!window.confirm('Distribuer ' + fmt(revenue) + ' FCFA entre ' + parts + ' parts (≈ ' + fmt(perPart) + ' FCFA par part) ?\nLes soldes seront crédités immédiatement. Cette action est définitive.')) return;
    const requestId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
    try {
      const r = await api('/api/admin/payouts', { method: 'POST', body: { domain: key, revenue, requestId } });
      out.style.color = 'var(--accent)';
      out.textContent = '✅ ' + fmt(r.distributed) + ' FCFA distribués à ' + r.investors + ' investisseur(s) (' + fmt(r.perUnit) + ' FCFA/part) · commissions d\'affiliation versées : ' + fmt(r.commissions) + ' FCFA';
      toast('Répartition effectuée');
    } catch (e) { out.style.color = 'var(--danger)'; out.textContent = e.message; }
  });

  /* ---------- Rafraîchissement automatique des données ---------- */
  const _showScreen = window.showScreen;
  window.showScreen = function (id) {
    _showScreen(id);
    if (token && !isAdminMode && ['screen-home', 'screen-history', 'screen-invest', 'screen-affiliation', 'screen-deposit'].indexOf(id) >= 0 && Date.now() - lastSync > 3000) {
      syncUser().catch(function () { /* silencieux */ });
    }
  };
  const _setLang = window.setLang;
  window.setLang = function (l) {
    _setLang(l);
    if (token && !isAdminMode) { remapHistory(); buildHistory(); buildInvestments(); buildAffiliates(); }
  };

  /* ---------- Reconnexion automatique si une session existe ---------- */
  if (token) { enterApp().catch(function () { /* 401 géré dans api() ; réseau : on reste sur l'accueil */ }); }
})();
