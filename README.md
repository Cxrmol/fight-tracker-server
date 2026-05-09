# Fight Tracker — Serveur API

API Node.js qui scrape Smoothcomp automatiquement et envoie les alertes Telegram.

## Déploiement sur Railway (gratuit)

### 1. Push sur GitHub
```bash
git init
git add .
git commit -m "fight tracker server"
git remote add origin https://github.com/TON_USERNAME/fight-tracker-server.git
git push -u origin main
```

### 2. Créer le projet sur Railway
1. Va sur [railway.app](https://railway.app) → **New Project**
2. **Deploy from GitHub repo** → sélectionne `fight-tracker-server`
3. Railway détecte le Dockerfile automatiquement

### 3. Ajouter les variables d'environnement
Dans Railway → ton projet → **Variables** → ajoute :

| Variable | Valeur |
|---|---|
| `TG_TOKEN` | Token de ton bot Telegram |
| `TG_CHAT_ID` | ID de ton canal Telegram |
| `TG_MINUTES` | `5` (minutes avant le combat) |

### 4. Récupérer l'URL de l'API
Dans Railway → **Settings** → **Domains** → génère un domaine.
Tu obtiens une URL comme `https://fight-tracker-server-production.up.railway.app`

→ **Copie cette URL**, tu en auras besoin pour configurer le site Netlify.

## Routes disponibles

- `GET /` — status du serveur
- `GET /api/matches` — tous les combats (JSON)
- `POST /api/refresh` — force un re-scrape immédiat

## Variables d'environnement

| Variable | Description | Défaut |
|---|---|---|
| `PORT` | Port du serveur | `3000` |
| `TG_TOKEN` | Token bot Telegram | — |
| `TG_CHAT_ID` | Chat ID canal Telegram | — |
| `TG_MINUTES` | Délai alerte avant combat | `5` |
