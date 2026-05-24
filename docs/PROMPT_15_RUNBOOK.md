# Prompt 15 — Multi-provider LLM operator runbook

## 1. Env vars to set

### Vercel (Production and Preview)

| Variable | Value / notes |
|---|---|
| `ANTHROPIC_API_KEY` | Existing Anthropic key (keep) |
| `OPENAI_API_KEY` | OpenAI key for streaming routes via AI SDK |
| `MISTRAL_API_KEY` | Mistral key for streaming routes via AI SDK |
| `MODEL_ANALYSIS` | `mistral-small-latest` (new default) |
| `MODEL_FAST` | `mistral-small-latest` (new default) |
| `MODEL_VISION` | `mistral-large-latest` (multimodal default) |
| `AI_GATEWAY_API_KEY` | Optional; Gateway accepts `openai/…`, `mistral/…`, `anthropic/…` slugs |

### Railway (Python backend)

| Variable | Value / notes |
|---|---|
| `KNOW_ANTHROPIC_API_KEY` | Anthropic chat (existing) |
| `KNOW_OPENAI_API_KEY` | **Same key** already used for embeddings + podcast TTS — reuse for chat; do not create a duplicate |
| `KNOW_MISTRAL_API_KEY` | **Same key** already used for OCR — reuse for chat; do not create a duplicate |
| `KNOW_ANALYSIS_MODEL` | `mistral-small-latest` |
| `KNOW_FAST_MODEL` | `mistral-small-latest` |

## 2. Migration steps

**None.** `users.analysis_model` and `users.fast_model` are TEXT NULL columns; no schema change. Existing NULLs resolve to env defaults (`mistral-small-latest`). Users with stored Anthropic picks (`claude-haiku-4-5`, etc.) keep working unchanged.

## 3. Rollback

Revert the merge commit. Anthropic code paths remain intact. Users who switched to Mistral after launch will be downgraded to their tier's `best_model` on rollback (Scholar → Sonnet, Researcher → Opus, Free → Mistral Small).

## 4. Smoke test sequence (after deploy)

1. **Settings (free user):** Open Settings. Confirm three provider sections with logos; Mistral Small selected by default; only fast-class models (Mistral Small, Haiku, GPT-5 mini) offered.
2. **Summary:** Run Summary on a ~12-page paper with each of: `mistral-small-latest`, `gpt-5`, `claude-sonnet-4-6`. All three should succeed and persist.
3. **Explain (vision):** Select an equation, run Explain with `mistral-large-latest`. Vision pipeline should attach PNG; if Mistral rejects image shape, falls back to text-only — check Railway logs for `selection.vision_fallback`.
4. **Existing user:** Sign in as a user with `claude-haiku-4-5` saved before deploy. Explain/Derive should still hit Anthropic.
5. **Gating:** As free user, attempt Opus via API override — should downgrade to `mistral-small-latest` and charge that cap.

## 5. Monitoring

- **Vercel:** Filter function logs for `tag: "summary-stream.error"` or `tag: "selection-stream.error"` where `errorMessage` contains `model` — stale slug under a new provider.
- **Railway:** Filter for `Selected model 'X' is not available` from `_raise_for_openai` / `_raise_for_mistral` / `_raise_for_anthropic`.
- **Usage caps:** Confirm per-model daily bars in Settings show all capped models for the tier after first call.

## 6. Tier matrix (reference)

| Tier | Fast models | Balanced | Top | `best_model` (downgrade target) |
|---|---|---|---|---|
| free | Mistral Small, Haiku, GPT-5 mini | — | — | `mistral-small-latest` |
| scholar | + above | Mistral Medium, Sonnet, GPT-5 | — | `claude-sonnet-4-6` |
| researcher | + above | + above | Mistral Large, Opus, GPT-5.4 | `claude-opus-4-7` |
