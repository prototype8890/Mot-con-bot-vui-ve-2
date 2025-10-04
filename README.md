# Patch for gemini-pro-fix-v2

Fixes: entry points, ABI, env schema, relay result normalization, simulate buy/sell, LP on-chain check, and DCA buy with proper router calldata.

Apply:
1) Backup your project.
2) Extract these files over your repo root (preserve `src` structure).
3) Fill `.env` using `.env.example`.
4) `npm i` then `npm start`.
