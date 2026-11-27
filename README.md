# Obsoleta

Quadro de tarefas e área de referências dos sócios da livraria.

- **Tarefas**: colunas são categorias; cada tarefa tem situação (a fazer / em andamento / concluída), prazo e um ou mais responsáveis. Arraste os cartões entre colunas (no celular, troque a categoria ao editar a tarefa).
- **Dependências**: ao editar uma tarefa, marque de quais outras ela depende. Enquanto alguma não estiver concluída, a tarefa aparece como bloqueada (🔒). Concluir uma tarefa bloqueada pede confirmação, mas não é impedido. Dependências circulares são recusadas.
- **Referências**: links, anotações e imagens agrupados por tema. Links ganham uma prévia (título, descrição e imagem da página); publicações públicas do Instagram podem ser abertas ali mesmo. Ao ampliar uma imagem dá para reagir com emojis e navegar entre as imagens da referência. Imagens são anexadas pelo botão "+ Imagem", pelo formulário ou arrastando arquivos sobre a referência.
- **Arquivos**: repositório de documentos (contratos, documentos dos sócios) organizado em pastas. Até 50 MB por arquivo; envio pelo botão ou arrastando para a pasta. PDFs, imagens e `.txt` abrem no navegador, o resto é baixado. Só quem está logado acessa.
- **Conta corrente dos sócios**: cada um lança os gastos que pagou do próprio bolso (valor, data, quem pagou, comprovantes anexos). A tela soma o que está em aberto por pessoa. Só quem lançou, quem pagou ou um admin altera um gasto; toda alteração de valor aparece nas novidades. Um admin "fecha o acerto", que marca tudo como acertado e zera os saldos. Exporta planilha (CSV).
- **Cardápio**: rascunho do nosso cardápio contra os preços das casas da região. Importa a planilha da coleta de cardápios (CSV separado por ponto e vírgula, colunas `cafe`, `item`, `preco`, `categoria`, `variacao`, `data_foto`, `leitura` e, opcionalmente, `tipo_casa` e `referencia`). O sistema reconhece os itens comparáveis (espresso, cappuccino, croissant…) e mostra, para cada um, o preço de cada casa, a mediana e onde o nosso preço fica. Reimportar uma casa substitui os itens dela. Preços de foto com mais de 12 meses ou de leitura incerta ficam marcados e podem ser escondidos.
- **Catálogo**: os livros das editoras, com capa, sinopse, autor, preço e situação, para montar a seleção do acervo. Busca por título, autor, tema ou ISBN e filtros por selo, gênero e situação. A estrela marca um livro como candidato (cada pessoa tem a sua; todos veem quem marcou) e "Exportar selecionados" gera a lista para consultar notas. Um admin importa a planilha do catálogo (CSV separado por ponto e vírgula). Cada linha é casada pelo ISBN e só as colunas preenchidas são gravadas, então planilhas parciais (outra editora, ou só ISBN e notas de Amazon/Goodreads/Skoob) entram por cima sem apagar nada. As capas são carregadas direto dos sites das editoras.
- **Comentários**: clicar numa tarefa abre a janela de leitura com a descrição e a conversa; o botão "Editar" fica no canto superior direito. Referências têm a mesma conversa. Digitar `@` sugere pessoas; quem é marcado vê um aviso "@ menções" no topo ao abrir o sistema (não há envio de e-mail).
- **Novidades (sininho)**: lista o que os outros fizeram desde a sua última visita — tarefas criadas, concluídas, movidas ou reatribuídas, referências, imagens, arquivos, comentários, novas pastas/temas/categorias e pessoas. Reações e reordenações não entram. Guarda as últimas 2.000 ações.
- **Busca**: `Ctrl+K` (ou `/`, ou a lupa) procura em tarefas, referências, arquivos e comentários, ignorando acentos.
- **Atualização ao vivo**: a tela recebe as mudanças dos outros em cerca de um segundo, sem recarregar. Depois de um deploy, a página se recarrega sozinha quando não há nada aberto.
- **Pessoas**: não existe cadastro público. Só um admin cria, edita e desativa contas.

Um único processo Node com banco SQLite em arquivo. Sem serviços externos.

## Rodar localmente

Requer Node 22.13 ou mais novo.

```bash
npm install
```

```bash
ADMIN_NAME="Seu Nome" ADMIN_EMAIL=voce@exemplo.com ADMIN_PASSWORD='uma-senha-longa' npm start
```

Abra http://localhost:3000. As variáveis `ADMIN_*` só são lidas quando o banco está vazio (primeira execução); depois disso podem ser removidas.

## Passkeys

Cada pessoa cadastra as suas em **Conta → Cadastrar passkey neste aparelho** e passa a entrar com "Entrar com passkey". A senha continua valendo como alternativa.

Uma passkey vale só para o domínio em que foi criada. Se o endereço do site mudar, as antigas deixam de funcionar: cada pessoa entra com senha, remove as antigas em Conta e cadastra de novo. Um admin pode remover as passkeys de alguém (aparelho perdido) em Pessoas → Editar.

## Variáveis de ambiente

| Variável | Para quê |
| --- | --- |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | Criam o primeiro admin se o banco estiver vazio. Senha com 10+ caracteres. |
| `DATA_DIR` | Pasta do banco (`obsoleta.db`) e das imagens (`uploads/`). Padrão: `./data`. |
| `APP_ORIGIN` | Opcional. Endereço público completo (ex.: `https://meusite.com`). Só defina se as passkeys forem recusadas: por padrão o app usa o endereço pelo qual foi acessado. |
| `PORT` | Porta HTTP. Padrão: 3000 (8080 no Docker). |
| `NODE_ENV=production` | Liga cookie `Secure`, HSTS e confia em um proxy reverso. **Obrigatório na internet.** |

## Colocar na internet

O `Dockerfile` roda em qualquer host de contêiner. Dois requisitos inegociáveis:

1. **HTTPS** na frente (praticamente todo PaaS já entrega). Com `NODE_ENV=production` o login não funciona em HTTP puro, de propósito.
2. **Disco persistente montado em `/data`**. Em hosts com disco efêmero (planos gratuitos sem volume) o banco some a cada deploy ou reinício.

Rode **uma única instância**: SQLite em arquivo e o limitador de tentativas de login não são compartilhados entre réplicas.

## Backup

Tudo fica em `DATA_DIR`: o banco `obsoleta.db`, as imagens das referências em `uploads/` e os documentos da aba Arquivos em `files/`. Não há backup automático dentro do app. São duas camadas, e vale ter as duas:

1. **No host**: agende snapshots do volume (no Railway, aba *Backups* do serviço). Cobre falha de disco e exclusão acidental, mas fica na mesma conta do host.
2. **Fora do host**: um admin baixa tudo em **Pessoas → Baixar backup agora**. O arquivo `.tar.gz` traz uma cópia consistente do banco (sem as sessões abertas) e todos os arquivos. Guarde em lugar seguro: ele contém os documentos e os hashes de senha.

### Restaurar

Com o app parado, extraia o backup dentro de `DATA_DIR` (substituindo `obsoleta.db`, `uploads/` e `files/`) e inicie de novo:

```bash
tar -xzf obsoleta-backup-AAAA-MM-DD-HH-MM.tar.gz -C /data
```

Todos precisam entrar de novo, com a senha ou passkey que tinham no momento do backup.

## Testes

```bash
npm test
```
