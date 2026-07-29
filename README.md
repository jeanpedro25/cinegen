<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# CineGen AI Studio

Aplicativo de geração de cenas com Gemini e Sogni Unlimited.

## Executar localmente

**Pré-requisito:** Node.js

1. Instale as dependências:

   `npm install`

2. Crie ou edite `.env.local`:

   ```env
   GEMINI_API_KEY=sua_chave_gemini
   SOGNI_API_KEY=sua_chave_sogni
   ```

3. Inicie o aplicativo:

   `npm run dev`

Abra `http://localhost:3000`.

## Fluxo inteligente

- **Estilo:** selecione `Nenhum preset` para usar apenas seu prompt; escolhendo
  um preset, ele será combinado com o prompt personalizado.
- **Personagem:** a imagem enviada é uma referência independente de identidade,
  usada em poses e ações diferentes.
- **Cenas:** escolha cortes por tempo ou SRT inteligente com uma cena por frase.
- **Edição:** somente imagens, edição automática com transições ou animação de
  cada cena com LTX 2.3.
- **Exportação:** o botão `Salvar projeto` permite escolher uma pasta no
  Chrome/Edge; em outros navegadores o sistema gera um ZIP organizado.

Para transcrever áudio sem um roteiro escrito, configure também
`GEMINI_API_KEY`. Sem essa chave, o sistema pede um roteiro real em vez de criar
dezenas de cenas genéricas repetidas.

As imagens são geradas no servidor local com o SDK oficial da Sogni, usando
`billingMode: "subscription"`, Krea 2 Turbo e até dezesseis trabalhos simultâneos
no plano Unlimited. Não publique a pasta como site estático: a rota local
`/api/cinegen/image` precisa do processo Vite (`npm run dev` ou
`npm run preview` depois de `npm run build`).
