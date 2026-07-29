export interface StylePreset {
  id: string;
  name: string;
  promptName: string;
  description: string;
  badge: string;
  previewUrl: string;
  previewSvg: string; // SVG fallback
}

export const ANIMATION_STYLES: StylePreset[] = [
  {
    id: 'aardman',
    name: 'Massinha Aardman',
    promptName: 'Massinha (Estilo Aardman)',
    description: 'Textura de argila moldada à mão, marcas de impressões digitais e estética Wallace & Gromit.',
    badge: 'Stop-Motion',
    previewUrl: 'https://image.pollinations.ai/prompt/claymation%20Aardman%20clay%20stop%20motion%20funny%20character%20Wallace%20and%20Gromit%20style%20plasticine%20texture?width=400&height=250&nologo=true&seed=42',
    previewSvg: `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200" width="300" height="200">
      <defs>
        <linearGradient id="g1" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="%23d97706"/>
          <stop offset="100%" stop-color="%2378350f"/>
        </linearGradient>
      </defs>
      <rect width="300" height="200" fill="%231e1b18"/>
      <circle cx="150" cy="100" r="60" fill="url(%23g1)" />
      <circle cx="130" cy="85" r="16" fill="%23ffffff"/>
      <circle cx="170" cy="85" r="16" fill="%23ffffff"/>
      <circle cx="132" cy="85" r="7" fill="%23000000"/>
      <circle cx="168" cy="85" r="7" fill="%23000000"/>
      <ellipse cx="150" cy="110" rx="12" ry="10" fill="%23b45309"/>
      <path d="M 125 130 Q 150 155 175 130" stroke="%23451a03" stroke-width="6" stroke-linecap="round" fill="none"/>
      <text x="150" y="180" font-family="sans-serif" font-size="12" font-weight="bold" fill="%23fbbf24" text-anchor="middle">AARDMAN CLAYMATION</text>
    </svg>`
  },
  {
    id: 'laika',
    name: 'Gótico Laika (Coraline)',
    promptName: 'Estúdio Laika (Estilo Coraline)',
    description: 'Atmosfera sombria e mágica, detalhes em feltro, olhos de botão e tons góticos sofisticados.',
    badge: 'Gótico',
    previewUrl: 'https://image.pollinations.ai/prompt/Laika%20Coraline%20style%20dark%20gothic%20stop%20motion%20puppet%20with%20button%20eyes%20and%20needlework?width=400&height=250&nologo=true&seed=101',
    previewSvg: `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200" width="300" height="200">
      <rect width="300" height="200" fill="%230f172a"/>
      <path d="M 0 200 L 150 50 L 300 200 Z" fill="%231e1b4b" opacity="0.6"/>
      <circle cx="150" cy="90" r="45" fill="%23312e81"/>
      <circle cx="132" cy="85" r="14" fill="%23020617" stroke="%23818cf8" stroke-width="2"/>
      <circle cx="132" cy="85" r="3" fill="%23818cf8"/>
      <circle cx="168" cy="85" r="14" fill="%23020617" stroke="%23818cf8" stroke-width="2"/>
      <circle cx="168" cy="85" r="3" fill="%23818cf8"/>
      <path d="M 135 115 Q 150 105 165 115" stroke="%23c7d2fe" stroke-width="3" stroke-linecap="round" fill="none"/>
      <text x="150" y="180" font-family="sans-serif" font-size="12" font-weight="bold" fill="%23a5b4fc" text-anchor="middle">CORALINE / LAIKA</text>
    </svg>`
  },
  {
    id: 'wes_anderson',
    name: 'Wes Anderson Pastel',
    promptName: 'Stop Motion Wes Anderson',
    description: 'Simetria rigorosa, paleta pastel amarelada e pelagem tátil no estilo O Fantástico Sr. Raposo.',
    badge: 'Pastel Cinema',
    previewUrl: 'https://image.pollinations.ai/prompt/Fantastic%20Mr%20Fox%20Wes%20Anderson%20style%20furry%20fox%20puppet%20stop%20motion%20pastel%20yellow%20symmetry?width=400&height=250&nologo=true&seed=202',
    previewSvg: `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200" width="300" height="200">
      <rect width="300" height="200" fill="%23fef3c7"/>
      <rect x="20" y="20" width="260" height="160" fill="none" stroke="%23d97706" stroke-width="2"/>
      <polygon points="150,40 210,130 90,130" fill="%23b45309"/>
      <circle cx="135" cy="80" r="6" fill="%23ffffff"/>
      <circle cx="165" cy="80" r="6" fill="%23ffffff"/>
      <circle cx="135" cy="80" r="3" fill="%23000000"/>
      <circle cx="165" cy="80" r="3" fill="%23000000"/>
      <polygon points="150,90 156,100 144,100" fill="%23451a03"/>
      <text x="150" y="165" font-family="serif" font-size="12" font-weight="bold" fill="%2392400e" text-anchor="middle">WES ANDERSON STYLE</text>
    </svg>`
  },
  {
    id: 'lego',
    name: 'Universo Lego',
    promptName: 'Estilo Lego Movie',
    description: 'Construções de blocos plásticos articulados, fogo de peças de plástico e iluminação de estúdio.',
    badge: 'Blocos 3D',
    previewUrl: 'https://image.pollinations.ai/prompt/Lego%20Movie%20style%20plastic%20minifigure%20brick%203D%20animation%20cinematic%20lighting?width=400&height=250&nologo=true&seed=303',
    previewSvg: `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200" width="300" height="200">
      <rect width="300" height="200" fill="%23ef4444"/>
      <rect x="100" y="60" width="100" height="80" rx="8" fill="%23f59e0b" stroke="%23b45309" stroke-width="3"/>
      <circle cx="120" cy="50" r="10" fill="%23f59e0b" stroke="%23b45309" stroke-width="2"/>
      <circle cx="180" cy="50" r="10" fill="%23f59e0b" stroke="%23b45309" stroke-width="2"/>
      <circle cx="135" cy="90" r="5" fill="%23000000"/>
      <circle cx="165" cy="90" r="5" fill="%23000000"/>
      <path d="M 130 115 Q 150 130 170 115" stroke="%23000000" stroke-width="4" fill="none"/>
      <text x="150" y="180" font-family="sans-serif" font-size="12" font-weight="bold" fill="%23ffffff" text-anchor="middle">LEGO MOVIE BRICKS</text>
    </svg>`
  },
  {
    id: 'tim_burton',
    name: 'Gótico Tim Burton',
    promptName: 'Gótico Tim Burton',
    description: 'Estética macabra e poética, pernas finas, olhos expressivos e alto contraste noir.',
    badge: 'Noir',
    previewUrl: 'https://image.pollinations.ai/prompt/Tim%20Burton%20Corpse%20Bride%20style%20dark%20gothic%20puppet%20stop%20motion%20character%20spooky?width=400&height=250&nologo=true&seed=404',
    previewSvg: `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200" width="300" height="200">
      <rect width="300" height="200" fill="%2318181b"/>
      <circle cx="230" cy="50" r="35" fill="%23e4e4e7" opacity="0.8"/>
      <path d="M 50 200 Q 120 80 180 200" fill="%2327272a"/>
      <circle cx="130" cy="90" r="25" fill="%23f4f4f5"/>
      <circle cx="120" cy="85" r="8" fill="%23000000"/>
      <circle cx="140" cy="85" r="8" fill="%23000000"/>
      <path d="M 115 105 Q 130 95 145 105" stroke="%23000000" stroke-width="2" fill="none"/>
      <text x="150" y="180" font-family="sans-serif" font-size="12" font-weight="bold" fill="%23a1a1aa" text-anchor="middle">TIM BURTON GOTHIC</text>
    </svg>`
  },
  {
    id: 'pixar_3d',
    name: '3D Pixar & Disney',
    promptName: 'Animação 3D Estilo Pixar Disney',
    description: 'Personagens carismáticos, renderização 3D fofinha, pele aveludada e iluminação cinematográfica.',
    badge: 'Render 3D',
    previewUrl: 'https://image.pollinations.ai/prompt/Pixar%20Disney%203D%20animation%20cute%20character%20cinematic%20soft%20lighting%20render?width=400&height=250&nologo=true&seed=505',
    previewSvg: `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200" width="300" height="200">
      <defs>
        <linearGradient id="p1" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="%2338bdf8"/>
          <stop offset="100%" stop-color="%231d4ed8"/>
        </linearGradient>
      </defs>
      <rect width="300" height="200" fill="%230284c7"/>
      <circle cx="150" cy="95" r="50" fill="url(%23p1)"/>
      <circle cx="130" cy="85" r="12" fill="%23ffffff"/>
      <circle cx="170" cy="85" r="12" fill="%23ffffff"/>
      <circle cx="132" cy="85" r="6" fill="%230284c7"/>
      <circle cx="168" cy="85" r="6" fill="%230284c7"/>
      <path d="M 125 110 Q 150 135 175 110" stroke="%23ffffff" stroke-width="5" stroke-linecap="round" fill="none"/>
      <text x="150" y="180" font-family="sans-serif" font-size="12" font-weight="bold" fill="%23bae6fd" text-anchor="middle">3D PIXAR MAGIC</text>
    </svg>`
  },
  {
    id: 'papercut',
    name: 'Recorte de Papel',
    promptName: 'Animação de Recorte de Papel',
    description: 'Camadas de papel dobrado e cortado com tesoura, profundidade de campo e iluminação suave.',
    badge: 'Papercraft',
    previewUrl: 'https://image.pollinations.ai/prompt/Papercut%20art%20origami%20layered%20paper%20stop%20motion%20animation%20forest%20depth?width=400&height=250&nologo=true&seed=606',
    previewSvg: `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200" width="300" height="200">
      <rect width="300" height="200" fill="%23064e3b"/>
      <path d="M 0 200 L 80 80 L 160 200 Z" fill="%23047857"/>
      <path d="M 100 200 L 200 60 L 300 200 Z" fill="%2310b981"/>
      <circle cx="150" cy="110" r="30" fill="%23fef08a" stroke="%23ca8a04" stroke-width="2"/>
      <text x="150" y="180" font-family="sans-serif" font-size="12" font-weight="bold" fill="%23a7f3d0" text-anchor="middle">PAPERCRAFT ART</text>
    </svg>`
  },
  {
    id: 'felt_wool',
    name: 'Feltro e Lã Feltrada',
    promptName: 'Feltro e Lã',
    description: 'Personagens em feltro macio, bordados visíveis, textura de fiação e atmosfera aconchegante.',
    badge: 'Artesanal',
    previewUrl: 'https://image.pollinations.ai/prompt/Needle%20felted%20wool%20fuzzy%20soft%20animal%20puppet%20handmade%20woolcraft?width=400&height=250&nologo=true&seed=707',
    previewSvg: `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200" width="300" height="200">
      <rect width="300" height="200" fill="%23831843"/>
      <circle cx="150" cy="95" r="48" fill="%23f472b6" stroke="%23fbcfe8" stroke-width="3" stroke-dasharray="6 4"/>
      <circle cx="132" cy="85" r="8" fill="%23500724"/>
      <circle cx="168" cy="85" r="8" fill="%23500724"/>
      <path d="M 135 110 Q 150 125 165 110" stroke="%23831843" stroke-width="4" stroke-linecap="round" fill="none"/>
      <text x="150" y="180" font-family="sans-serif" font-size="12" font-weight="bold" fill="%23fbcfe8" text-anchor="middle">FELT & WOOL ART</text>
    </svg>`
  }
];
