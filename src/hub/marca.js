// A marca do Tracking Lab em vetor: um tubo de vidro de laboratorio em forma de
// infinito (o ciclo venda -> Meta -> anuncio -> venda), com o liquido verde do
// sinal, a escala graduada e as tampas. Geometria limpa e tampas quadradas,
// para combinar com a fonte "robotica" do Hub.
//
// O infinito e feito de dois CIRCULOS (raio R) ligados por duas diagonais que
// se cruzam no meio -- os pontos de tangencia sao calculados aqui.

const R = 24;
const ESQ = { x: 20, y: 40 };
const DIR = { x: 100, y: 40 };
const NIVEL = 27; // o nivel do liquido (y): acima dele, so vidro
const TUBO = 17;

const r2 = (n) => Math.round(n * 100) / 100;
const pt = (c, graus, raio = R) => ({ x: r2(c.x + raio * Math.cos((graus * Math.PI) / 180)), y: r2(c.y + raio * Math.sin((graus * Math.PI) / 180)) });

// Angulo de tangencia a partir do cruzamento (60,40): a = asin(R/d).
const ANG = 90 - (Math.asin(R / (DIR.x - 60)) * 180) / Math.PI; // ~53 graus
const dSup = pt(DIR, 180 + ANG); // direita, em cima
const dInf = pt(DIR, 180 - ANG); // direita, embaixo
const eSup = pt(ESQ, -ANG); // esquerda, em cima
const eInf = pt(ESQ, ANG); // esquerda, embaixo

const LACO = `M${eInf.x} ${eInf.y} L${dSup.x} ${dSup.y} A${R} ${R} 0 1 1 ${dInf.x} ${dInf.y} L${eSup.x} ${eSup.y} A${R} ${R} 0 1 0 ${eInf.x} ${eInf.y} Z`;
// A diagonal que passa POR CIMA no cruzamento (de baixo-esquerda a cima-direita).
const POR_CIMA = `M${eInf.x} ${eInf.y} L${dSup.x} ${dSup.y}`;

function tampa(c, graus, cor, larg = 8) {
  const a = pt(c, graus, R + TUBO / 2 - 1);
  const b = pt(c, graus, R + TUBO / 2 + 4);
  const t = pt(c, graus, R + TUBO / 2 + 7.5);
  return `<path d="M${a.x} ${a.y} L${b.x} ${b.y}" stroke="#bfe9dc" stroke-width="4.2" stroke-linecap="butt"/>`
    + `<rect x="${r2(t.x - larg / 2)}" y="${r2(t.y - 3.5)}" width="${larg}" height="7" rx="1.2" fill="${cor}" stroke="#0e1014" stroke-width="1.2" transform="rotate(${r2(graus + 90)} ${t.x} ${t.y})"/>`;
}

function escala(c, de, ate, passo) {
  let d = '';
  for (let g = de; g <= ate; g += passo) {
    const a = pt(c, g, R - 5.5);
    const b = pt(c, g, R - (g % (passo * 3) === 0 ? 1 : 3));
    d += `M${a.x} ${a.y} L${b.x} ${b.y} `;
  }
  return d;
}

export function logoSvg({ tamanho = 64, fundo = false } = {}) {
  const largura = tamanho;
  const altura = Math.round((tamanho * 88) / 168);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-26 -10 168 88" width="${largura}" height="${altura}" role="img" aria-label="Tracking Lab">
<defs>
  <clipPath id="tl-liq"><rect x="-30" y="${NIVEL}" width="190" height="70"/></clipPath>
  <linearGradient id="tl-vidro" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a6f7cf"/><stop offset=".55" stop-color="#7fb2ff"/><stop offset="1" stop-color="#c49cff"/></linearGradient>
</defs>
${fundo ? '<rect x="-26" y="-10" width="168" height="88" rx="8" fill="#16181c"/>' : ''}
<g>${tampa(ESQ, 212, '#22b8c7')}${tampa(ESQ, 243, '#ff7a3d')}${tampa(ESQ, 304, '#4d8dff')}${tampa(DIR, 312, '#22b8c7')}${tampa(DIR, 342, '#a6f7cf', 6)}${tampa(DIR, 40, '#1fae9a', 9)}
  ${(() => { const a = pt(ESQ, 272, R + TUBO / 2 - 1); const b = pt(ESQ, 272, R + TUBO / 2 + 6); return `<path d="M${a.x} ${a.y} L${b.x} ${b.y}" stroke="#bfe9dc" stroke-width="3.4"/><rect x="${r2(b.x - 7)}" y="${r2(b.y - 5)}" width="14" height="3.6" rx="1" fill="#ff7a3d" stroke="#0e1014" stroke-width="1.1"/><circle cx="${b.x}" cy="${r2(b.y + 1)}" r="2.6" fill="#4d8dff" stroke="#0e1014" stroke-width="1.1"/>`; })()}
</g>
<!-- vidro: contorno colorido + interior escuro -->
<path d="${LACO}" fill="none" stroke="url(#tl-vidro)" stroke-width="${TUBO + 4}" stroke-linejoin="round"/>
<path d="${LACO}" fill="none" stroke="#1d2a26" stroke-width="${TUBO}" stroke-linejoin="round"/>
<!-- liquido (o sinal) abaixo do nivel -->
<path d="${LACO}" fill="none" stroke="#35e35a" stroke-width="${TUBO}" stroke-linejoin="round" clip-path="url(#tl-liq)"/>
<!-- cruzamento: a diagonal de cima, com uma fresta escura -->
<path d="${POR_CIMA}" stroke="#0e1014" stroke-width="${TUBO + 8}" stroke-linecap="butt" opacity=".55"/>
<path d="${POR_CIMA}" stroke="url(#tl-vidro)" stroke-width="${TUBO + 4}" stroke-linecap="butt"/>
<path d="${POR_CIMA}" stroke="#1d2a26" stroke-width="${TUBO}" stroke-linecap="butt"/>
<path d="${POR_CIMA}" stroke="#35e35a" stroke-width="${TUBO}" stroke-linecap="butt" clip-path="url(#tl-liq)"/>
<!-- escala graduada -->
<path d="${escala(ESQ, 120, 210, 10)} ${escala(DIR, -40, 50, 10)}" stroke="#bdfdcb" stroke-width="1" stroke-linecap="square" opacity=".75"/>
<!-- bolhas (quadradas) e brilho -->
<g fill="#c9ffd5"><rect x="4" y="56" width="2.6" height="2.6"/><rect x="34" y="52" width="1.9" height="1.9"/><rect x="58" y="44" width="2.2" height="2.2"/><rect x="108" y="58" width="2.6" height="2.6"/><rect x="118" y="48" width="1.9" height="1.9"/></g>
<path d="M${r2(ESQ.x - 14)} ${r2(ESQ.y - 15)} A${R} ${R} 0 0 1 ${r2(ESQ.x + 4)} ${r2(ESQ.y - R + 0.5)}" fill="none" stroke="#ffffff" stroke-width="1.6" stroke-linecap="square" opacity=".5"/>
<path d="M${r2(DIR.x - 4)} ${r2(DIR.y - R + 0.5)} A${R} ${R} 0 0 1 ${r2(DIR.x + 12)} ${r2(DIR.y - 20.5)}" fill="none" stroke="#ffffff" stroke-width="1.6" stroke-linecap="square" opacity=".5"/>
<path d="M${r2(eInf.x + 12)} ${r2(eInf.y - 10)} L${r2(dSup.x - 14)} ${r2(dSup.y + 10)}" stroke="#ffffff" stroke-width="1.4" stroke-linecap="square" opacity=".45"/>
</svg>`;
}

/** Icone da aba: so o infinito, no quadrado escuro. */
export const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-14 -2 148 84"><rect x="-14" y="-2" width="148" height="84" rx="12" fill="#16181c"/><path d="${LACO}" fill="none" stroke="#35e35a" stroke-width="${TUBO}" stroke-linejoin="round"/><path d="${POR_CIMA}" stroke="#16181c" stroke-width="${TUBO + 6}"/><path d="${POR_CIMA}" stroke="#35e35a" stroke-width="${TUBO}"/></svg>`;
