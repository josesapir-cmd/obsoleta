# Obsoleta

Quadro de tarefas e área de referências dos sócios da livraria.

- **Tarefas**: colunas são categorias; cada tarefa tem situação (a fazer / em andamento / concluída), prazo e um ou mais responsáveis. Arraste os cartões entre colunas (no celular, troque a categoria ao editar a tarefa).
- **Referências**: links, anotações e imagens agrupados por tema. Links ganham uma prévia (título, descrição e imagem da página); publicações públicas do Instagram podem ser abertas ali mesmo. Ao ampliar uma imagem dá para reagir com emojis e navegar entre as imagens da referência. Imagens são anexadas pelo botão "+ Imagem", pelo formulário ou arrastando arquivos sobre a referência.
- **Comentários**: clicar numa tarefa abre a janela de leitura com a descrição e a conversa; o botão "Editar" fica no canto superior direito. Referências têm a mesma conversa. Digitar `@` sugere pessoas; quem é marcado vê um aviso "@ menções" no topo ao abrir o sistema (não há envio de e-mail).
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

São duas coisas, ambas em `DATA_DIR`: o banco `obsoleta.db` e a pasta `uploads/` com as imagens anexadas. Um sem o outro fica incompleto. Para copiar o banco com o app no ar:

```bash
sqlite3 /data/obsoleta.db ".backup '/data/backup.db'"
```

Não há backup automático. O snapshot do volume do host cobre banco e imagens de uma vez; é a opção mais simples.

## Testes

```bash
npm test
```
