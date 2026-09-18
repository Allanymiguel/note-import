# note-import

Adicione notas, etiquetas e grifo/marcação de publicações ao seu JW Library usando backup de outro dispositivo.

Tudo roda **inteiramente no navegador**. Os dois `.jwlibrary` selecionados são lidos localmente, mesclados em memória, e o resultado é oferecido como download — os arquivos originais nunca são alterados.

## Como usar

1. Abra [`app/mesclar_notas.html`](app/mesclar_notas.html) no navegador (funciona direto via `file://`, sem precisar de servidor).
2. Faça backup do seu JW Library e do dispositivo de quem vai te enviar as notas (`.jwlibrary`).
3. Selecione os dois arquivos na página: o seu (destinatário) e o recebido (remetente).
4. Escolha o que importar:
   - **Importar tudo** — mescla todas as notas e todos os grifos/marcações (com ou sem nota associada).
   - **Importar apenas notas** — mescla só as notas, suas tags e os grifos ligados a elas; ignora marcações soltas sem nota.
   - **Importar só as marcações de um artigo específico** — escolhe manualmente de quais publicações/edições copiar os grifos.
5. Baixe o arquivo `..._mesclado.jwlibrary` gerado e abra-o no JW Library para importar.

A ferramenta nunca duplica dados: notas e grifos já existentes (mesmo `Guid`/`UserMarkGuid`) são reconhecidos e ignorados na segunda vez. Se nada de novo for encontrado, nenhum arquivo é gerado.

> **Observação:** o JW Library exibe, ao restaurar qualquer backup, um aviso padrão de que "notas, etiquetas, destaques, favoritos, marcadores e playlists serão substituídos". Essa é a mensagem genérica do app para qualquer restauração — esta ferramenta só mexe em **notas, etiquetas e marcações/grifos em parágrafos**; favoritos, marcadores e playlists não são tocados.

## Estrutura do projeto

```
app/
  mesclar_notas.html   página principal (UI + orquestração do fluxo)
  mesclar_notas.css    estilos
  merge-core.js        lógica de merge (SQL sobre sql.js), compartilhada entre navegador e Node
test/
  merge-core.test.js   suíte de testes da lógica de merge
  zip.test.js          testes de leitura/escrita de arquivos .jwlibrary (zip) reais
  helpers.js           helpers para criar bancos SQLite de teste
```

`app/merge-core.js` é um módulo UMD: roda tanto no navegador (via `<script>`, expõe `window.MergeCore`) quanto no Node (via `require`), para poder ser testado sem depender do DOM.

## Bibliotecas usadas

- [sql.js](https://github.com/sql-js/sql.js) — SQLite compilado para WebAssembly, para ler/editar o `userData.db` dentro do backup.
- [JSZip](https://stuk.github.io/jszip/) — leitura e geração dos arquivos `.jwlibrary` (que são arquivos zip).

No HTML, ambas são carregadas via CDN (cdnjs) com [Subresource Integrity](https://developer.mozilla.org/docs/Web/Security/Subresource_Integrity) habilitado.

## Desenvolvimento e testes

Requer [Node.js](https://nodejs.org/).

```bash
npm install
npm test
```

Os testes usam `sql.js` e `jszip` diretamente no Node para validar a lógica de merge (dedup por `Guid`/chave natural de `Location`, idempotência, `foreign_key_check`, leitura/escrita de `.jwlibrary` reais) sem precisar de navegador.
