# Conexão da API Sogni no CineGen IA

## 1. Obter a chave

1. Acesse `https://dashboard.sogni.ai/api-key`.
2. Entre na conta Sogni.
3. Crie ou copie uma API key ativa.
4. Não coloque a chave em código React, commits, capturas de tela ou arquivos públicos.

## 2. Configurar o CineGen

Na raiz do projeto, abra o arquivo `.env.local` e configure:

```env
SOGNI_API_KEY=SUA_CHAVE_SOGNI
GEMINI_API_KEY=SUA_CHAVE_GEMINI
```

- `SOGNI_API_KEY`: geração de imagens e vídeos.
- `GEMINI_API_KEY`: transcrição de áudio, análise da referência visual e preparação dos prompts.
- Não use aspas e não deixe espaços ao redor do sinal `=`.

Depois de alterar uma chave, reinicie o servidor. Variáveis do `.env.local` são
carregadas somente durante a inicialização.

```powershell
npm.cmd run build
npm.cmd run preview -- --host 127.0.0.1 --port 3002
```

Abra:

```text
http://localhost:3002/
```

## 3. Como a conexão funciona neste projeto

O navegador nunca envia a chave diretamente para a Sogni.

```text
Interface React
   ├─ POST /api/cinegen/image
   └─ POST /api/cinegen/video
              ↓
Servidor local CineGen
              ↓
@sogni-ai/sogni-client
              ↓
Sogni Supernet
```

O servidor cria a conexão:

```ts
const client = await SogniClient.createInstance({
  appId: "cinegen-ai-studio",
  appSource: "cinegen-ai-studio",
  network: "fast",
  apiKey: process.env.SOGNI_API_KEY,
});
```

Não é necessário executar `login()` quando a autenticação usa API key.

## 4. Geração de imagem

A interface chama:

```http
POST /api/cinegen/image
Content-Type: application/json
```

O servidor abre um projeto Sogni do tipo `image`, aguarda a conclusão e devolve
a URL final da imagem.

Configuração usada pelo CineGen:

- rede `fast`;
- cobrança `subscription`;
- modelo padrão Krea 2 Turbo;
- uma chamada independente por cena;
- seed diferente por cena;
- referência de estilo convertida em perfil visual;
- referência de personagem enviada como imagem inicial somente quando esse modo
  for selecionado.

## 5. Geração de vídeo

A interface chama:

```http
POST /api/cinegen/video
Content-Type: application/json
```

O servidor usa LTX-2.3 Image-to-Video com o quadro gerado para aquela cena.
O prompt solicita somente efeitos sonoros diegéticos e proíbe música, voz,
diálogo e narração.

## 6. Testar a instalação

Teste primeiro se o site está no ar:

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3002/
```

O resultado esperado é:

```text
StatusCode: 200
```

Depois, gere um projeto pequeno com duas cenas. Isso valida:

1. autenticação Sogni;
2. disponibilidade do modelo;
3. geração de imagens;
4. retorno das URLs;
5. animação das cenas marcadas como vídeo.

## 7. Erros comuns

### `401`, `403` ou `unauthorized`

- A chave está inválida, expirada ou foi revogada.
- Gere outra chave no painel Sogni.
- Atualize `.env.local`.
- Reinicie o servidor.

### `SOGNI_API_KEY não está configurada`

- Confirme que `.env.local` está na raiz do projeto.
- Confirme o nome exato `SOGNI_API_KEY`.
- Não use `VITE_SOGNI_API_KEY`, pois isso poderia expor a chave ao navegador.

### Modelo indisponível

- Verifique a conta, assinatura ou saldo.
- Confirme se o modelo está disponível na rede `fast`.
- O CineGen tenta novamente e pode usar o modelo alternativo configurado.

### `Failed to fetch`

- Confirme que o servidor está rodando na porta 3002.
- Não abra apenas o arquivo `index.html`; use o servidor Vite.
- Verifique firewall, proxy e conexão de internet.

## 8. Segurança

- Mantenha `.env.local` no `.gitignore`.
- Nunca coloque a chave em `App.tsx` ou em arquivos dentro de `public`.
- Não envie a chave pelo frontend.
- Revogue e substitua imediatamente uma chave publicada ou compartilhada.
- Use uma chave separada para desenvolvimento e produção.

## Referências oficiais

- API Reference: https://docs.sogni.ai/api-reference/
- SDK Sogni: https://docs.sogni.ai/sogni-sdk/
- Painel de API keys: https://dashboard.sogni.ai/api-key

