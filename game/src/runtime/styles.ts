export const gameStyles = `
.doom-threejs{position:relative;width:100%;background:#080909;color:#f5f2e9;font-family:monospace}
.doom-stage{position:relative;width:100%;outline:none;display:grid;place-items:center;background:#000}
.doom-screen{position:relative;width:100%;aspect-ratio:4/3;overflow:hidden;background:#000}
.doom-screen canvas{position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated}
.doom-screen .doom-world{height:84%}
.doom-overlay{pointer-events:none}
.doom-stage:focus-visible{outline:2px solid #dbdd45;outline-offset:3px}
.doom-threejs:fullscreen{--doom-controls-height:0px;width:100vw;height:100dvh;display:flex;flex-direction:column;justify-content:center;background:#000}
.doom-threejs:fullscreen .doom-stage{height:calc(100dvh - var(--doom-controls-height))}
.doom-threejs:fullscreen .doom-screen{width:min(100vw,calc((100dvh - var(--doom-controls-height)) * 4 / 3))}
.doom-error{position:absolute;inset:0;display:grid;place-content:center;gap:1rem;padding:2rem;background:#090b0de8;z-index:5;text-align:center}
.doom-error[hidden]{display:none}
.doom-error button,.doom-touch button{font:inherit;color:inherit;background:#252727;border:1px solid #535654;padding:.75rem 1rem;cursor:pointer}
.doom-touch{display:none;gap:.25rem;grid-template-columns:repeat(7,minmax(0,1fr));padding:.5rem}
.doom-touch button{box-sizing:border-box;touch-action:none;padding:.75rem .25rem;min-height:44px;font-size:.7rem;user-select:none}
.doom-touch button:active{background:#55594b}
.doom-sr{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(pointer:coarse){.doom-touch{display:grid}.doom-threejs:fullscreen{--doom-controls-height:60px}}
`;
