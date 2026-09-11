# Calendário de Leilões — Leiloaria Smart

Calendário web que mostra, dia a dia, quantos lotes **encerram** naquela data.
Clicando no dia abre a lista com horário, valor e link direto para a página do
lote em `leiloariasmart.com.br`.

**No ar em:** https://calendario.leiloariasmart.com.br
(`leiloaria-smart.github.io` continua respondendo e redireciona para lá; ver
[Domínio próprio](#domínio-próprio))

> O repositório se chama `Leiloaria-Smart.github.io` de propósito: repositório
> com o nome `usuario.github.io` é publicado na **raiz** do endereço, sem o
> nome do repositório depois da barra. Renomear o repositório muda o endereço
> do site junto.

Os dados são extraídos automaticamente de https://leiloariasmart.com.br/busca,
de hora em hora das 9h às 19h, segunda a sexta, sem ninguém precisar rodar
nada.

---

## Como funciona, em uma frase

Um workflow do GitHub Actions roda o scraper de hora em hora, commita os dados
se o acervo mudou e republica o site. **Não há nada para fazer manualmente** —
nem rodar script, nem subir arquivo.

```
9h, 10h, ... 19h (seg-sex) → scraper → mudou? → commit → publica no GitHub Pages
                                    ↘ veio quebrado? → não publica → abre issue → e-mail
```

---

## Rodar à mão (opcional)

Só é preciso quando se quer conferir alguma coisa na hora, ou depois de mexer
no `scraper.js`.

```bash
node scraper.js                    # pega tudo que estiver publicado
node scraper.js --ate 2026-09-30   # só até a data indicada
node scraper.js --forcar           # grava mesmo com a conferência reclamando
```

Gera dois arquivos em `site/`:

| Arquivo | Para quê |
|---|---|
| `lotes.json` | dados limpos, para integrações (n8n, API, planilha, outro front) |
| `lotes.js`   | mesmo conteúdo em `window.DADOS_LEILAO`, usado pelo calendário |

O `.js` existe porque o navegador bloqueia `fetch()` de arquivo local
(`file://`) — com ele o `index.html` abre com duplo clique, sem servidor.

Códigos de saída: `0` gravou (ou não precisou), `1` erro de rede/HTTP,
`2` recusou gravar porque o resultado parecia quebrado.

> **Cuidado com o `--ate`:** ele grava por cima do `lotes.json` de produção com
> um recorte parcial. Se você commitar esse arquivo, o site perde os lotes que
> ficaram de fora. Depois de usar, rode `node scraper.js` de novo antes de
> commitar.

### Abrir o calendário localmente

Duplo clique em `site/index.html`, ou `npx serve site` para servir de verdade.

---

## Estrutura

```
calendario-leiloes/
├── scraper.js                        # baixa e parseia o site -> lotes.json + lotes.js
├── site/
│   ├── index.html                    # o calendário (arquivo único, sem dependências)
│   ├── lotes.json                    # dados gerados
│   └── lotes.js                      # dados gerados (window.DADOS_LEILAO)
├── .github/workflows/calendario.yml  # a automação: coleta, commita e publica
├── .gitattributes                    # LF fixo (o scraper roda no Windows e no Linux)
└── README.md
```

---

## Formato do `lotes.json`

```jsonc
{
  "fonte": "https://leiloariasmart.com.br/busca",
  "atualizadoEm": "2026-08-19T11:58:54.000Z",
  "total": 187,              // imóveis
  "totalPracas": 261,        // datas agendadas (um imóvel pode ter 1ª e 2ª praça)
  "primeiraData": "2026-08-04",
  "ultimaData": "2026-09-29",
  "lotes": [
    {
      "id": 1700,
      "titulo": "Apto 88m² - Goiânia/GO",
      "url": "https://leiloariasmart.com.br/imovel/1700",
      "imagem": "https://leiloariasmart.com.br/_admin_/upload/....jpg",
      "tipo": "Apartamento",          // derivado do título
      "cidade": "Goiânia",
      "uf": "GO",
      "modalidade": "Extrajudicial",
      "comitente": "VERT Companhia Securitizadora",
      "situacao": "Desocupado",
      "desconto": "50%",
      "descontoTexto": "abaixo na 2ª praça",
      "precoDestaque": "R$ 470.000,00",
      "visitas": 1142,
      "pracas": [
        { "ordem": 1, "rotulo": "1ª praça", "data": "2026-08-04",
          "dataBr": "04/08/2026", "hora": "13:55",
          "valor": "R$ 940.000,00", "encerrada": true },
        { "ordem": 2, "rotulo": "2ª praça", "data": "2026-08-25",
          "dataBr": "25/08/2026", "hora": "13:55",
          "valor": "R$ 470.000,00", "encerrada": false }
      ]
    }
  ]
}
```

**Só o encerramento vira evento no calendário — um por imóvel.** O JSON traz
todas as praças (por isso `totalPracas` é maior que `total`), mas o calendário
exibe apenas a que fecha o lote: a **2ª praça** para quem tem duas, a **praça
única** para os outros. A 1ª praça é etapa intermediária e não aparece — nem na
grade, nem nos KPIs, nem nos gráficos.

Cuidado ao mexer: `1ª praça` e `Praça única` têm **as duas `ordem: 1`**; o que as
separa é o `rotulo`. Quem decide é `ehEncerramento()` no `index.html`.

---

## Como o scraper funciona

O site é server-rendered (HTML pronto, sem API pública), e `/busca` devolve o
catálogo inteiro numa página só — sem paginação. O scraper:

1. baixa o HTML de `/busca` (~1,2 MB);
2. quebra em cards pelo marcador `<div class="caixa-imoveis">`;
3. lê de cada card: `info-imovel-1` (modalidade/comitente), `info-imovel-2`
   (título e link), `info-imovel-3` / `info-imovel-4` / `info-imovel-5`
   (datas das praças), `percentual-praca`, `preco-imovel`, `visitas-imovel`,
   `faixa-*-imovel` (ocupado/desocupado);
4. deriva `tipo`, `cidade` e `uf` a partir do título;
5. **confere o resultado** (abaixo) e só então grava.

Sem dependências externas — só `fetch` nativo do Node 18+.

### Quando ele se recusa a gravar

Este é o ponto mais importante do projeto, e o motivo de ele poder rodar
sozinho. O parsing depende das classes CSS do site. Se elas mudarem, o scraper
**não estoura erro** — ele volta vazio, calado. Sem proteção, a automação
publicaria um calendário em branco todo dia e ninguém perceberia.

Antes de gravar, ele para se:

| Sinal | O que denuncia |
|---|---|
| página com menos de 100 KB | caiu numa página de erro ou bloqueio |
| nenhum card no HTML | o marcador `caixa-imoveis` mudou |
| nenhum lote com praça | os blocos de data mudaram |
| mais de 20% dos lotes sem título | `info-imovel-2` mudou |
| total caiu mais de 75% | mudança grande demais para ser real |
| praças por lote caíram mais de 25% | um dos blocos de data mudou, e os lotes vêm com datas faltando |

Recusando, ele sai com código `2` **sem tocar nos arquivos** — o calendário
continua no ar com os dados bons do dia anterior, em vez de ficar vazio.

O último sinal existe porque os outros não pegavam o caso mais traiçoeiro:
renomeando só o bloco da 2ª praça, vêm os mesmos 187 lotes, com título, numa
página de 1,2 MB — cada um com metade das datas. A proporção de praças por lote
cai de 1,40 para 1,00 e entrega.

### Ele também não reescreve quando nada mudou

Duas coisas mudam sozinhas a cada coleta sem o acervo ter mudado: o carimbo de
tempo e o contador de visitas de cada imóvel. Só o contador respondia por 74 das
76 linhas de um diff de dia normal, num campo que o calendário nem exibe.
Ignorando os dois, **cada commit do histórico significa mudança real no
acervo** — e dá para ver o que aconteceu no catálogo só olhando a lista de
commits.

### Se o site mudar o HTML

O ponto a conferir é `parseCard()` no `scraper.js` — as classes provavelmente
mudaram de nome. A issue que a automação abre já diz isso e mostra qual
conferência reclamou.

---

## Observações sobre os dados

- **Percentuais negativos** (`-8%`) existem no site: significam lance acima da
  avaliação. O calendário mostra como "8% acima", em cinza, em vez de "OFF".
- **Praças já encerradas** vêm marcadas com `"encerrada": true` (o site rasura
  esses blocos). Elas continuam no JSON para manter o histórico do mês; o
  calendário só exibe o que ainda vai acontecer.
- **O filtro "Praça" só tem 2ª e única.** Não há opção de 1ª praça porque ela
  não entra no calendário.
- **"Hoje" é o dia em Brasília**, não em UTC nem no fuso de quem abre a página.
  O calendário se vira sozinho: como a data é calculada no navegador a cada
  visita, ele avança de dia mesmo que passe uma semana sem commit novo.
- **Janela corrida de 60 dias.** O calendário cobre 60 dias contados a partir
  de hoje — hoje é o dia 1 — e anda um dia por dia: em 19/08 vai até 17/10;
  em 20/08, o dia 19/08 sai e o fim pula para 18/10. Praça fora da janela sai
  de tudo — grade,
  feirões, KPIs e gráficos. Dia depois do limite aparece esmaecido, igual aos
  dias passados, para não se confundir com dia sem leilão.
  O tamanho da janela é a constante `JANELA_DIAS` no `index.html`.
- Dentro da janela, a navegação ainda para nos meses que têm lotes — não dá
  para navegar para um mês vazio.

---

## Publicação e atualização automática

Tudo vive em `.github/workflows/calendario.yml`, num único workflow com três
jobs. O agendamento é `13 12-22 * * 1-5` — de hora em hora das 12h13 às 22h13
UTC, segunda a sexta, que é 9h13 às 19h13 em Brasília (UTC-3 o ano todo, sem
horário de verão).

### Aviso ao marketing quando sobe imóvel novo

Toda vez que uma varredura encontra `id` de imóvel que não estava na coleta
anterior, o job `dados` manda um e-mail de `tech@leiloariasmart.com.br` para
`marketing@`, `avaliacao@` e `lucas@leiloariasmart.com.br` com a
contagem e o tipo/cidade/preço/link de cada um. Quem decide isso é o próprio
`scraper.js` (comparando com o `lotes.json` que já estava no disco antes de
sobrescrever); o passo *Avisar o marketing sobre imóveis novos*, no workflow,
só lê o resultado (`novos-imoveis.json`, gerado na raiz do repo, nunca
comitado) e manda pelo SMTP da Hostinger via `curl`. A lista de destinatários
é o array `para` nesse passo.

Não dispara na primeira execução depois de configurado (não há "anterior"
para comparar) nem quando a coleta é rejeitada pela conferência — só quando
um imóvel realmente novo aparece numa coleta válida.

**Configuração:** o repositório precisa do secret `SMTP_PASS` (Settings →
Secrets and variables → Actions → New repository secret), com a senha da
caixa `tech@leiloariasmart.com.br`. Host, porta e usuário (SMTP da Hostinger,
`smtp.hostinger.com:465`) estão fixos no workflow — só a senha é secreta.
Sem o secret configurado, o passo falha mas **não trava a publicação do
calendário** (`continue-on-error: true` — ver comentário no workflow);
ele só aparece marcado no run do Actions.

### Por que tudo num run só

Um push feito de dentro de um workflow com o `GITHUB_TOKEN` **não dispara outro
workflow** (é a proteção do GitHub contra loop infinito). Separar "coletar" e
"publicar" em dois workflows faria o scraper commitar todo dia e o site nunca
sair do lugar. Por isso os jobs são ligados por `needs`, no mesmo run.

Pela mesma razão, os dois `checkout` pedem `ref` explícito: o padrão traz o
commit que disparou o run, que fica atrás da ponta de `main` assim que o job
anterior empurra os dados.

### Rodar fora de hora

Actions → *Atualizar e publicar o calendário* → **Run workflow**. Serve também
quando uma execução agendada for pulada (o GitHub avisa que execução agendada
pode atrasar ou ser descartada em horário de pico — por isso o agendamento é
sempre no minuto 13, e não em ponto).

### Domínio próprio

**No ar em `calendario.leiloariasmart.com.br` desde 20/08/2026.** Está assim:

| Onde | O quê |
|---|---|
| Route 53, zona `leiloariasmart.com.br` | `CNAME`, nome `calendario`, valor `leiloaria-smart.github.io`, TTL 300 |
| Settings → Pages → Custom domain | `calendario.leiloariasmart.com.br` |
| Settings → Pages → Enforce HTTPS | marcado — o certificado é emitido e renovado pelo GitHub |

No valor do `CNAME` não entra o nome do repositório — é sempre
`usuario.github.io`.

O DNS de `leiloariasmart.com.br` está no **Route 53 (AWS)**.

> **Atenção, e isso engana:** o *e-mail* do domínio está na Hostinger (os `MX`
> apontam para `mx1/mx2.hostinger.com`), então é natural supor que o DNS
> também esteja. Não está. Os nameservers registrados no Registro.br são os do
> Route 53, e é ele quem responde as consultas. Um registro criado no painel da
> Hostinger fica numa zona inativa e **não tem efeito nenhum** — você espera
> propagar uma coisa que nunca vai propagar.
>
> E não vale a pena "resolver" isso mudando os nameservers para a Hostinger: a
> zona serve três provedores ao mesmo tempo — a raiz e o `www` na AWS (o site),
> os `MX`/`autodiscover`/`autoconfig` na Hostinger (o e-mail) e o `admin` no
> Google (`ghs.googlehosted.com`), mais o SPF e a verificação do Google nos
> `TXT`. Recriar isso à mão em outro provedor arrisca derrubar site, e-mail ou
> painel, e só quem tem acesso ao Route 53 consegue listar a zona inteira com
> segurança — de fora, só dá para achar os nomes que se adivinha.

**Não adianta criar um arquivo `CNAME` na pasta `site/`**: com publicação via
Actions, o GitHub ignora esse arquivo. O domínio vive só na configuração do
Pages — e por isso mudar de domínio não pede commit nenhum, só o campo em
Settings e o registro no Route 53.

O *Enforce HTTPS* só fica clicável depois que o certificado sai. Aqui saiu em
poucos minutos, mas o GitHub se reserva 24 h; até lá o `https://` pode dar erro
de certificado, e não é DNS errado.

Como este repositório é o site raiz da organização, o domínio vale como base do
Pages de toda a `Leiloaria-Smart`: um segundo repositório publicando no Pages
responderia em `calendario.leiloariasmart.com.br/nome-do-repo`, a menos que
receba um domínio próprio.

---

## Quando chegar um e-mail de falha

A automação abre uma issue quando algo quebra, e o GitHub manda o e-mail. A
issue já vem com o diagnóstico, e distingue os dois casos:

- **"A coleta dos dados falhou"** — o scraper recusou o resultado. Mostra qual
  conferência reclamou. O calendário continua no ar com os dados de ontem. Se os
  dados estiverem certos e a conferência é que foi rigorosa demais,
  `node scraper.js --forcar` grava assim mesmo.
- **"A publicação falhou"** — a coleta funcionou; quem falhou foi o deploy.
  Costuma ser passageiro; reexecutar o workflow resolve.

Havendo issue aberta, a automação **comenta nela** em vez de abrir outra — o
e-mail chega igual, sem virar uma issue por dia. Feche a issue quando resolver.

### Um caso que não gera aviso

Em repositório público, o GitHub **desativa workflows agendados após 60 dias sem
atividade humana no repositório** — e commits feitos pelo próprio bot em geral
não contam. O GitHub avisa por e-mail antes de desativar; para religar é Actions
→ o workflow → *Enable workflow*. Um `Run workflow` manual de vez em quando
também segura.
