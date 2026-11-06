# Tap2ETH landing page

A concise, scroll-driven 3D landing page (React 18 + Vite + Three.js): tap the card,
get a signature, approve on the phone. Real transaction receipts and wallet features
follow, with protocol details and demo limitations in expandable sections.
The demo video sits directly below the hero in a responsive YouTube player.

```bash
cd landing
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in landing/dist (relative paths, deploy anywhere)
```

How it fits together:

- `src/App.jsx` holds every section and its copy. Elements with `data-station="…"` are 3D keyframes:
  `hero`, `gone2` (demo), `tap2`, `secret2`, `pay2`, and `gone1`.
- `src/scene.js` builds the scene (card layers, copper antenna, chip, die, NFC reader, field lines,
  phone, wallet contract) and blends between stations as you scroll. Tune camera and object poses in
  the `S.*` station table.
- `src/Stage.jsx` mounts the fixed canvas. The hero frames the card within its layout slot;
  story scenes place the objects beside the copy on desktop and above it on mobile.
- Fonts load from Google Fonts. Without WebGL the page still reads top to bottom with a CSS card in the hero.
