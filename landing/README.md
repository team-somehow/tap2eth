# Tap2ETH landing page

A scroll-driven 3D landing page (React 18 + Vite + Three.js) that explains how a contactless tap works,
where the private key lives inside the card's chip, and how Tap2ETH turns it into a wallet.

```bash
cd landing
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in landing/dist (relative paths, deploy anywhere)
```

How it fits together:

- `src/App.jsx` holds every section and its copy. Elements with `data-station="…"` are 3D keyframes.
- `src/scene.js` builds the scene (card layers, copper antenna, chip, die, NFC reader, field lines,
  phone, wallet contract) and blends between stations as you scroll. Tune camera and object poses in
  the `S.*` station table.
- `src/Stage.jsx` mounts the fixed canvas; `src/useScrollProgress.js` drives the scroll-linked
  details (APDU log, hash bytes, contract checklist, statement words).
- Fonts load from Google Fonts. Without WebGL the page still reads top to bottom with a CSS card in the hero.
