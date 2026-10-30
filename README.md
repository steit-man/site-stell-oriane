# InvestPlus — site + backend

Backend **Node.js + Express + SQLite**, qui sert aussi le site (`public/`). Tout (comptes, soldes, dépôts,
investissements, gains, affiliation, droits admin) est géré et vérifié **côté serveur**.

## Démarrage

```bash
npm install
cp .env.example .env      # puis ouvrez .env et adaptez les valeurs
npm start                 # → http://localhost:3000
npm test                  # tests des calculs (répartition, commissions)
```
Prérequis : Node.js 18 ou plus récent.

## Configuration (`.env`)

| Variable | Rôle |
|---|---|
| `ADMIN_PHONE` / `ADMIN_PASSWORD` | Compte administrateur (créé au démarrage ; changez le mot de passe ici puis redémarrez). **`0001` est trop faible pour un site public** : prenez 12 caractères ou plus. |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Assistant IA des questions techniques. La clé reste **sur le serveur**, jamais dans le site. Sans clé, l'assistant répond « indisponible ». |
| `SMTP_*`, `SUPPORT_EMAIL` | Envoi des questions d'argent par email à `lsteit772@gmail.com`. Pour Gmail : validation en 2 étapes puis « mot de passe d'application ». Sans SMTP, les messages sont quand même enregistrés et visibles dans l'espace admin. |
| `JWT_SECRET` | Optionnel (sinon généré dans `data/jwt.secret`). |
| `TRUST_PROXY` | Mettre `1` derrière un proxy HTTPS (Render, Railway, Nginx…). |

## Comment circule l'argent

1. **Dépôt** : l'utilisateur choisit l'opérateur, saisit montant + numéro + code secret → le téléphone compose le code USSD.
   Le serveur crée une demande **en attente** (référence `DEP-XXXXXX`). Le code secret n'est jamais envoyé au serveur.
2. **Confirmation** : l'admin ouvre *Accueil* → « Dépôts à confirmer », vérifie la réception dans son compte mobile money
   (montant, numéro expéditeur, heure) puis clique **Confirmer reçu** → le solde est crédité.
3. **Investissement** : 1 unité = 500 FCFA, déduite du solde (refusée si solde insuffisant).
4. **Gains** : onglet *Gestion* → saisir le revenu d'un domaine → **Distribuer**. Répartition au prorata des parts
   (ex. 5 000 FCFA ÷ 500 parts = 10 FCFA/part). Un identifiant unique par clic empêche la double distribution.
5. **Affiliation** : un filleul s'inscrit avec le code de son parrain ; à chaque gain de 10 FCFA du filleul,
   le parrain reçoit 2 FCFA. ⚠️ La commission est payée **en plus** par la plateforme (elle n'est pas retirée de la part du filleul).
6. **Retrait** : possible uniquement vers un numéro enregistré sur le compte ; l'admin envoie l'argent puis clique **Marquer payé**
   (ou **Rejeter** pour rembourser le solde).

## Sécurité déjà en place
Mots de passe hachés (bcrypt) · sessions JWT invalidées au changement de mot de passe · blocage 15 min après 5 échecs de connexion ·
limitation de débit · requêtes SQL paramétrées · validation stricte des entrées · échappement HTML dans l'espace admin ·
droits admin vérifiés en base à chaque requête · soldes jamais négatifs (contrainte SQL) · opérations d'argent en transactions atomiques ·
aucun identifiant admin ni donnée fictive dans le code du site.

## Mise en ligne (rappels)
- **HTTPS obligatoire** (hébergeur ou Nginx + Let's Encrypt).
- Sauvegardez régulièrement `data/investplus.db` (c'est toute votre base).
- Ne publiez jamais `.env` ni `data/`.
- SQLite = un seul serveur ; suffisant pour démarrer, à migrer vers PostgreSQL si l'activité grandit.

## Pas encore fait
- **Écran de retrait** dans le site (l'API `POST /api/withdrawals` et le traitement admin existent déjà).
- **Confirmation automatique des dépôts** : aujourd'hui l'admin confirme à la main. Pour l'automatiser il faut une API marchand
  (agrégateur de paiement couvrant T-Money/Flooz au Togo, à vérifier auprès d'eux).
- Mot de passe oublié, vérification de l'email, double authentification de l'admin.
- Aspect réglementaire : collecter de l'argent du public avec promesse de rendement est encadré (UEMOA/BCEAO, régulateur financier).
  Renseignez-vous auprès d'un juriste ou du régulateur avant d'ouvrir avec de l'argent réel.

## API (résumé)
`POST /api/auth/register|login` · `GET|PUT /api/me` · `GET /api/history` · `GET /api/affiliates` · `POST /api/deposits` ·
`POST /api/investments` · `POST /api/withdrawals` · `POST /api/support/ai|money` ·
admin : `GET /api/admin/overview|stats` · `POST /api/admin/deposits/:id/confirm|reject` ·
`POST /api/admin/withdrawals/:id/paid|reject` · `POST /api/admin/payouts`
