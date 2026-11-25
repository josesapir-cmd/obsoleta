# Obsoleta

Quadro de tarefas e área de referências dos sócios da livraria.

- **Tarefas**: colunas são categorias; cada tarefa tem situação (a fazer / em andamento / concluída), prazo e um ou mais responsáveis. Arraste os cartões entre colunas (no celular, troque a categoria ao editar a tarefa).
- **Referências**: links e anotações agrupados por tema.
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

## Variáveis de ambiente

| Variável | Para quê |
| --- | --- |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | Criam o primeiro admin se o banco estiver vazio. Senha com 10+ caracteres. |
| `DATA_DIR` | Pasta do banco (`obsoleta.db`). Padrão: `./data`. |
| `PORT` | Porta HTTP. Padrão: 3000 (8080 no Docker). |
| `NODE_ENV=production` | Liga cookie `Secure`, HSTS e confia em um proxy reverso. **Obrigatório na internet.** |

## Colocar na internet

O `Dockerfile` roda em qualquer host de contêiner. Dois requisitos inegociáveis:

1. **HTTPS** na frente (praticamente todo PaaS já entrega). Com `NODE_ENV=production` o login não funciona em HTTP puro, de propósito.
2. **Disco persistente montado em `/data`**. Em hosts com disco efêmero (planos gratuitos sem volume) o banco some a cada deploy ou reinício.

Rode **uma única instância**: SQLite em arquivo e o limitador de tentativas de login não são compartilhados entre réplicas.

## Backup

Tudo está em `DATA_DIR/obsoleta.db`. Para copiar com o app no ar:

```bash
sqlite3 /data/obsoleta.db ".backup '/data/backup.db'"
```

Não há backup automático — configure o do seu host (snapshot do volume) ou agende o comando acima.

## Testes

```bash
npm test
```
