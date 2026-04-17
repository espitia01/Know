# Know

Interactive academic paper reader with AI-powered analysis. Upload a PDF, get clean LaTeX-rich markdown, and use AI tools to study it: pre-reading prep, derivation exercises, assumptions analysis, Q&A, notes, and more.

## Architecture

- **Frontend**: Next.js 16 (App Router), Tailwind CSS, shadcn/ui, KaTeX
- **Backend**: Python FastAPI, PyMuPDF, httpx (Anthropic API / local models)
- **LLM**: Anthropic Claude (Haiku for formatting, Sonnet for analysis) or any OpenAI-compatible local model (Ollama, LM Studio)

## Quick Start (Local)

### Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Edit .env with your API keys
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:3000

## Deployment: Vercel (Frontend) + Home Server (Backend)

See the deployment guide below.

### 1. Mac Studio Setup (Backend + Ollama)

```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Pull Qwen model
ollama pull qwen3:8b

# Clone the repo
git clone https://github.com/espitia01/Know.git
cd Know/backend

# Set up Python environment
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Configure environment
cp .env.example .env
```

Edit `backend/.env`:
```
KNOW_ACTIVE_PROVIDER=local
KNOW_LOCAL_MODEL_URL=http://localhost:11434/v1
KNOW_LOCAL_MODEL_NAME=qwen3:8b
KNOW_CORS_ORIGINS=https://your-app.vercel.app
```

Start the backend:
```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

### 2. Expose Backend to the Internet

Your Vercel frontend needs to reach your Mac Studio. Options:

**Option A: Cloudflare Tunnel (recommended, free)**
```bash
# Install cloudflared
brew install cloudflare/cloudflare/cloudflared

# Authenticate
cloudflared tunnel login

# Create a tunnel
cloudflared tunnel create know-api

# Route traffic
cloudflared tunnel route dns know-api api.yourdomain.com

# Run the tunnel
cloudflared tunnel --url http://localhost:8000 run know-api
```

**Option B: Tailscale Funnel (if you use Tailscale)**
```bash
tailscale funnel 8000
```

**Option C: ngrok**
```bash
ngrok http 8000
```

Take note of the public URL (e.g., `https://api.yourdomain.com` or `https://xxxx.ngrok-free.app`).

Update `backend/.env` to include your Vercel domain in CORS:
```
KNOW_CORS_ORIGINS=https://know-xyz.vercel.app
```

### 3. Deploy Frontend to Vercel

```bash
cd frontend
npx vercel
```

When prompted, set this environment variable:
```
NEXT_PUBLIC_API_URL=https://api.yourdomain.com
```

Or set it in the Vercel dashboard under Settings → Environment Variables:
- Key: `NEXT_PUBLIC_API_URL`
- Value: Your backend's public URL (from step 2)

Then deploy:
```bash
npx vercel --prod
```

### 4. Verify

1. Open your Vercel URL
2. Upload a PDF
3. Check the backend logs on your Mac Studio — you should see requests coming in

## Environment Variables

### Backend (`backend/.env`)
| Variable | Description | Default |
|---|---|---|
| `KNOW_ANTHROPIC_API_KEY` | Anthropic API key | (empty) |
| `KNOW_LOCAL_MODEL_URL` | OpenAI-compatible endpoint | `http://localhost:11434/v1` |
| `KNOW_LOCAL_MODEL_NAME` | Model name | `qwen3:8b` |
| `KNOW_ACTIVE_PROVIDER` | `anthropic` or `local` | `anthropic` |
| `KNOW_CORS_ORIGINS` | Comma-separated allowed origins | (empty) |

### Frontend
| Variable | Description | Default |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | Backend URL | `http://localhost:8000` |
