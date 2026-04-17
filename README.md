# Know

Interactive academic paper reader with AI-powered analysis. Upload a PDF, get clean LaTeX-rich markdown, and use AI tools to study it: pre-reading prep, derivation exercises, assumptions analysis, Q&A, notes, and more.

## Architecture

- **Frontend**: Next.js 16 (App Router), Tailwind CSS, shadcn/ui, KaTeX
- **Backend**: Python FastAPI, PyMuPDF, httpx (Anthropic API / local models)
- **LLM**: Anthropic Claude (Haiku for formatting, Sonnet for analysis) or any OpenAI-compatible local model (Ollama, LM Studio)
- **Auth**: Simple password gate (token-based, configurable via `KNOW_PASSWORD`)

## Quick Start (Local)

### Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Edit .env with your API keys and password
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:3000 and sign in with your password.

---

## Deployment: Vercel (Frontend) + Mac Studio (Backend) + Ollama/Qwen

### Step 1: Mac Studio Setup

```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Pull Qwen
ollama pull qwen3:8b

# Verify it works
ollama run qwen3:8b "Say hello"
# Ctrl+D to exit

# Clone the repo
git clone https://github.com/espitia01/Know.git
cd Know/backend

# Python env
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Configure
cp .env.example .env
```

Edit `backend/.env`:
```
KNOW_ACTIVE_PROVIDER=local
KNOW_LOCAL_MODEL_URL=http://localhost:11434/v1
KNOW_LOCAL_MODEL_NAME=qwen3:8b
KNOW_PASSWORD=Ebong1996
KNOW_CORS_ORIGINS=https://your-app.vercel.app
```

### Step 2: Expose Backend with localtunnel

```bash
# Install localtunnel globally
npm install -g localtunnel

# Start the backend
uvicorn app.main:app --host 0.0.0.0 --port 8000

# In another terminal, start the tunnel
lt --port 8000 --subdomain know-api
```

This gives you a URL like `https://know-api.loca.lt`.

> **Note**: localtunnel shows a "click to continue" splash page on first visit.
> To bypass it programmatically, your requests need the header
> `Bypass-Tunnel-Reminder: true`. The app already sends auth headers
> which usually suffice, but if you hit the splash page in a browser,
> just click through once.

### Step 3: Deploy Frontend to Vercel

```bash
cd Know/frontend
npx vercel
```

Set the environment variable (in Vercel dashboard → Settings → Environment Variables):
- **Key**: `NEXT_PUBLIC_API_URL`
- **Value**: `https://know-api.loca.lt` (your localtunnel URL from step 2)

Deploy to production:
```bash
npx vercel --prod
```

Then update `backend/.env` with your actual Vercel domain:
```
KNOW_CORS_ORIGINS=https://know-xyz.vercel.app
```

### Step 4: Verify

1. Open your Vercel URL → you should see the login page
2. Sign in with your password
3. Upload a PDF → watch your Mac Studio terminal for requests

---

## Using tmux (keep everything running)

tmux lets you run multiple persistent terminal sessions that survive if you close your laptop or SSH disconnects. Here's how to use it for Know:

### Install
```bash
# macOS
brew install tmux
```

### Start a session
```bash
tmux new -s know
```

You're now inside a tmux session named "know".

### Split into panes (run all 3 services at once)

```
# You start in pane 0. Start Ollama:
ollama serve

# Split horizontally (new pane below):
Ctrl+B then "       (that's Ctrl+B, release, then press the double-quote key)

# In the new pane, start the backend:
cd Know/backend && source .venv/bin/activate
uvicorn app.main:app --host 0.0.0.0 --port 8000

# Split again:
Ctrl+B then "

# In the third pane, start localtunnel:
lt --port 8000 --subdomain know-api
```

### Essential tmux commands

| Action | Keys |
|---|---|
| Split pane horizontally | `Ctrl+B` then `"` |
| Split pane vertically | `Ctrl+B` then `%` |
| Switch between panes | `Ctrl+B` then arrow key |
| **Detach** (leave running) | `Ctrl+B` then `d` |
| **Re-attach** (come back) | `tmux attach -t know` |
| List sessions | `tmux ls` |
| Kill a session | `tmux kill-session -t know` |
| Scroll up in a pane | `Ctrl+B` then `[`, then arrow keys. Press `q` to exit scroll mode |
| Resize pane | `Ctrl+B` then hold `Ctrl` + arrow key |

### The key workflow

1. **Start**: `tmux new -s know`
2. **Set up panes**: Split and start your 3 services (Ollama, backend, localtunnel)
3. **Detach**: `Ctrl+B` then `d` — everything keeps running in the background
4. **Come back later**: `tmux attach -t know` — all your panes are still there
5. **After reboot**: just run `tmux new -s know` and start the services again

This means you can SSH into your Mac Studio, start everything in tmux, detach, close your laptop, and the backend stays running.

---

## Environment Variables

### Backend (`backend/.env`)
| Variable | Description | Default |
|---|---|---|
| `KNOW_PASSWORD` | Login password | `Ebong1996` |
| `KNOW_ANTHROPIC_API_KEY` | Anthropic API key | (empty) |
| `KNOW_LOCAL_MODEL_URL` | OpenAI-compatible endpoint | `http://localhost:11434/v1` |
| `KNOW_LOCAL_MODEL_NAME` | Model name | `qwen3:8b` |
| `KNOW_ACTIVE_PROVIDER` | `anthropic` or `local` | `anthropic` |
| `KNOW_CORS_ORIGINS` | Comma-separated allowed origins | (empty) |

### Frontend (Vercel env vars)
| Variable | Description | Default |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | Backend URL | `http://localhost:8000` |
