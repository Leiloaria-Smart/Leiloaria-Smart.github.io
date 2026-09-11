/**
 * Scraper da Leiloaria Smart -> gera site/lotes.json
 *
 * Uso:
 *   node scraper.js
 *   node scraper.js --ate 2026-09-30     (filtra praças até a data indicada)
 *   node scraper.js --forcar             (grava mesmo com a conferência reclamando)
 *
 * Saída 0 = gravou. 1 = erro (rede, HTTP). 2 = recusou gravar: o resultado
 * tem cara de parsing quebrado e os dados anteriores foram preservados.
 *
 * Sem dependências externas: usa fetch nativo do Node 18+ e parsing por regex
 * em cima do HTML server-rendered de https://leiloariasmart.com.br/busca
 */

const fs = require('fs');
const path = require('path');

const BASE = 'https://leiloariasmart.com.br';
const FONTE = `${BASE}/busca`;
const SAIDA = path.join(__dirname, 'site', 'lotes.json');
const SAIDA_JS = SAIDA.replace(/\.json$/, '.js');

// Fica na raiz do repo, não em site/: é para o workflow ler e montar o
// e-mail do marketing, nunca é comitado nem publicado.
const NOVOS = path.join(__dirname, 'novos-imoveis.json');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ---------------------------------------------------------------- utilidades

const limpa = (html) =>
  html
    .replace(/<sup>.*?<\/sup>/gi, 'a')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&ordm;/g, 'º')
    .replace(/[ \t]+/g, ' ')
    .trim();

const pega = (bloco, re) => {
  const m = bloco.match(re);
  return m ? limpa(m[1]) : null;
};

/** "18/08/2026" -> "2026-08-18" */
const isoData = (br) => {
  if (!br) return null;
  const [d, m, a] = br.split('/');
  return `${a}-${m}-${d}`;
};

/** Extrai data / hora / valor de um bloco de praça. */
function leParaca(html, rotulo, ordem) {
  if (!html) return null;
  const texto = limpa(html);
  const data = (texto.match(/\d{2}\/\d{2}\/\d{4}/) || [])[0];
  if (!data) return null;
  return {
    ordem,
    rotulo,
    data: isoData(data),
    dataBr: data,
    hora: (texto.match(/\b\d{1,2}:\d{2}\b/) || [])[0] || null,
    valor: (texto.match(/R\$\s*[\d.,]+/) || [])[0] || null,
  };
}

/**
 * Deriva tipo do imóvel a partir do título.
 * Ordem importa: termos mais específicos primeiro ("Casa de Condomínio"
 * precisa vencer "Casa").
 */
const TIPOS = [
  ['Casa de Condomínio', 'casa de condom'],
  ['Casa de Condomínio', 'casa em condom'],
  ['Apartamento', 'apartamento duplex'],
  ['Edificação Mista', 'edificação mista'],
  ['Imóvel comercial', 'imóvel comercial'],
  ['Imóvel comercial', 'imovel comercial'],
  ['Imóvel misto', 'imóvel misto'],
  ['Imóvel misto', 'imovel misto'],
  ['Terreno', 'terreno industrial'],
  ['Sala comercial', 'sala comercial'],
  ['Apartamento', 'apartamento'],
  ['Apartamento', 'apto'],
  ['Cobertura', 'cobertura'],
  ['Sobrado', 'sobrado'],
  ['Terreno', 'terreno'],
  ['Galpão', 'galpão'],
  ['Chácara', 'chácara'],
  ['Fazenda', 'fazenda'],
  ['Sítio', 'sítio'],
  ['Prédio', 'prédio'],
  ['Casa', 'casa'],
  ['Terreno', 'lote'],
  ['Loja', 'loja'],
  ['Sala comercial', 'sala'],
  ['Kitnet', 'kitnet'],
  ['Flat', 'flat'],
  ['Terreno', 'gleba'],
  ['Terreno', 'área'],
  ['Galpão', 'barracão'],
  ['Galpão', 'pavilhão'],
  ['Vaga de garagem', 'vaga'],
];

function derivaTipo(titulo) {
  if (!titulo) return 'Outros';
  const t = titulo.toLowerCase();
  for (const [tipo, chave] of TIPOS) {
    if (t.includes(chave)) return tipo;
  }
  return 'Outros';
}

/**
 * Extrai "Cidade/UF" do título. Cobre as variações usadas no site:
 * "São Mateus/ES", "Americana - SP", "BEBEDOURO SP",
 * "Aparecida de Goiânia/GO — Área de 3.000 m²".
 */
const UFS = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG',
  'PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'];

function derivaLocal(titulo) {
  if (!titulo) return { cidade: null, uf: null };

  // acha a última UF válida usada como sigla isolada
  const re = /[\s\/\-–—]([A-Za-z]{2})(?![A-Za-zÀ-ú])/g;
  let m, achado = null;
  while ((m = re.exec(titulo)) !== null) {
    if (UFS.includes(m[1].toUpperCase())) achado = m;
  }
  if (!achado) return { cidade: null, uf: null };

  // cidade = palavras imediatamente antes da UF, parando em número/travessão
  const antes = titulo.slice(0, achado.index);
  const cm = antes.match(/([A-Za-zÀ-ú'´\.]+(?:\s+[A-Za-zÀ-ú'´\.]+)*)\s*[\-–—,]?\s*$/);
  let cidade = cm ? cm[1].trim() : null;

  // descarta prefixos de tipo que grudaram na captura ("Casa São Mateus")
  if (cidade) {
    const palavras = cidade.split(/\s+/);
    while (palavras.length > 1 && TIPOS.some(([, k]) =>
      palavras[0].toLowerCase().startsWith(k.slice(0, 4)))) {
      palavras.shift();
    }
    cidade = palavras.join(' ');
    // normaliza CAIXA ALTA -> Caixa Alta
    if (cidade === cidade.toUpperCase()) {
      cidade = cidade.toLowerCase().replace(/(^|\s)(\p{L})/gu, (s) => s.toUpperCase());
    }
  }

  return { cidade: cidade || null, uf: achado[1].toUpperCase() };
}

// ------------------------------------------------------------------- parsing

function parseCard(bloco) {
  const id = (bloco.match(/href="\/imovel\/(\d+)"/) || [])[1];
  if (!id) return null;

  const titulo = pega(bloco, /info-imovel-2[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/);
  const categoria = pega(bloco, /info-imovel-1"[^>]*>([\s\S]*?)<\/div>/);

  // categoria vem como "Extrajudicial - A.F - RIZA SECURITIZADORA S.A"
  const partes = (categoria || '').split(/\s+-\s+/);
  const modalidade = partes[0] || null;
  const comitente = partes.length > 1 ? partes[partes.length - 1] : null;

  const pracas = [];

  // Padrão A: 1ª praça (info-imovel-3) + 2ª praça (info-imovel-4)
  const b3 = bloco.match(/info-imovel-3([^"]*)"[^>]*>([\s\S]*?)<\/div>/);
  // Padrão B: "PRAÇA ÚNICA" em info-imovel-5 + data em info-imovel-4
  const b5 = bloco.match(/info-imovel-5[^"]*"[^>]*>([\s\S]*?)<\/div>/);
  const b4 = bloco.match(/info-imovel-4([^"]*)"[^>]*>([\s\S]*?)<\/div>/);

  if (b3) {
    const p = leParaca(b3[2], '1ª praça', 1);
    if (p) {
      p.encerrada = /through|disabled/.test(b3[1]);
      pracas.push(p);
    }
  }
  if (b4) {
    const unica = b5 && /única|unica/i.test(limpa(b5[1]));
    const p = leParaca(b4[2], unica ? 'Praça única' : '2ª praça', unica ? 1 : 2);
    if (p) {
      p.encerrada = /through|disabled/.test(b4[1]);
      pracas.push(p);
    }
  }

  const local = derivaLocal(titulo);
  const situacao = pega(bloco, /faixa-\w+-imovel"[^>]*>([^<]*)<\/div>/) || null;

  return {
    id: Number(id),
    titulo,
    url: `${BASE}/imovel/${id}`,
    imagem: (bloco.match(/<img src="(https:\/\/[^"]*_admin_\/upload\/[^"]+)"/) || [])[1] || null,
    tipo: derivaTipo(titulo),
    cidade: local.cidade,
    uf: local.uf,
    modalidade,
    comitente,
    situacao: situacao || null,
    desconto: pega(bloco, /percentual-praca">([^<]+)<\/span>/),
    descontoTexto: pega(bloco, /percentual-praca">[^<]+<\/span>([\s\S]*?)<\/div>/),
    precoDestaque: pega(bloco, /preco-imovel">([^<]+)<\/div>/),
    visitas: Number((bloco.match(/visitas-imovel">\s*(\d+)/) || [])[1] || 0),
    pracas,
  };
}

// -------------------------------------------------------------- conferência

/**
 * Lê o lotes.json que já está no disco, para comparar.
 *
 * Devolve null também quando o arquivo é JSON válido mas não tem a cara
 * esperada — um arquivo pela metade não pode virar base de comparação nem
 * derrubar o scraper com TypeError lá na frente.
 */
function leAnterior() {
  try {
    const d = JSON.parse(fs.readFileSync(SAIDA, 'utf8'));
    if (!d || !Array.isArray(d.lotes) || typeof d.total !== 'number') return null;
    return d;
  } catch {
    return null;
  }
}

/**
 * Duas coisas mudam sozinhas a cada coleta, sem o acervo ter mudado: o
 * carimbo de tempo e o contador de visitas de cada imóvel. Só o contador
 * responde por quase todo o diff de um dia normal — e o calendário nem
 * exibe esse número.
 *
 * Ignorando os dois, cada gravação (e cada commit que o Actions faz em
 * cima dela) passa a significar mudança de verdade no acervo.
 */
function mudouDeVerdade(antes, depois) {
  const semRuido = (d) =>
    JSON.stringify({
      ...d,
      atualizadoEm: null,
      lotes: d.lotes.map((l) => ({ ...l, visitas: 0 })),
    });
  return semRuido(antes) !== semRuido(depois);
}

/**
 * Devolve a lista de motivos para NÃO gravar.
 *
 * O parsing depende de classes CSS do site. Se elas mudarem, o scraper não
 * quebra com erro — ele volta vazio, calado. Rodando sozinho todo dia pelo
 * GitHub Actions, isso publicaria um calendário em branco sem ninguém
 * perceber. Então ele prefere parar e deixar no ar os dados bons de ontem.
 *
 * `comparar` fica falso quando se usa --ate, porque aí a queda no número de
 * lotes é o efeito pedido, não sintoma de defeito.
 */
function confere(saida, html, qtdCards, comparar) {
  const motivos = [];

  if (html.length < 100 * 1024) {
    motivos.push(
      `a página veio com ${(html.length / 1024).toFixed(0)} KB; o normal passa ` +
        'de 1 MB — provavelmente caiu numa página de erro ou de bloqueio'
    );
  }

  if (qtdCards === 0) {
    motivos.push(
      'nenhum card encontrado no HTML — o marcador <div class="caixa-imoveis"> mudou'
    );
  }

  if (saida.total === 0) {
    motivos.push(
      'nenhum lote com praça — os blocos info-imovel-3/4 (as datas) mudaram'
    );
  }

  const semTitulo = saida.lotes.filter((l) => !l.titulo).length;
  if (saida.total > 0 && semTitulo / saida.total > 0.2) {
    motivos.push(
      `${semTitulo} dos ${saida.total} lotes vieram sem título — info-imovel-2 mudou`
    );
  }

  if (comparar) {
    const antes = leAnterior();
    // com menos de 20 lotes na base a proporção não diz nada
    if (antes && antes.total >= 20 && saida.total < antes.total * 0.25) {
      motivos.push(
        `o total caiu de ${antes.total} para ${saida.total} lotes; sumir três ` +
          'quartos do acervo de um dia para o outro não acontece de verdade'
      );
    }

    // Praças por lote. Os limites acima olham só a contagem de lotes, e há
    // uma quebra que passa por baixo de todos eles: se mudar o nome do bloco
    // da 2ª praça, vêm os mesmos 187 lotes, com título, numa página de tamanho
    // normal — só que cada um com metade das datas. A proporção cai de 1,4
    // para 1,0 e denuncia. Ela não se move sozinha: é característica do
    // acervo, não do dia.
    if (antes && antes.total >= 20 && saida.total > 0) {
      const razaoAntes = antes.totalPracas / antes.total;
      const razaoAgora = saida.totalPracas / saida.total;
      if (razaoAntes >= 1.1 && razaoAgora < razaoAntes * 0.75) {
        motivos.push(
          `as praças por lote caíram de ${razaoAntes.toFixed(2)} para ` +
            `${razaoAgora.toFixed(2)} — um dos blocos de data (info-imovel-3/4/5) ` +
            'deve ter mudado, e os lotes estão vindo com datas faltando'
        );
      }
    }
  }

  return motivos;
}

// --------------------------------------------------------------------- main

async function main() {
  const argAte = process.argv.indexOf('--ate');
  const ate = argAte > -1 ? process.argv[argAte + 1] : null;
  const forcar = process.argv.includes('--forcar');

  console.log(`Baixando ${FONTE} ...`);
  const resp = await fetch(FONTE, { headers: { 'User-Agent': UA } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ao buscar ${FONTE}`);
  const html = await resp.text();
  console.log(`  ${(html.length / 1024).toFixed(0)} KB recebidos`);

  const cards = html.split('<div class="caixa-imoveis">').slice(1);
  console.log(`  ${cards.length} cards encontrados`);

  let lotes = cards.map(parseCard).filter((l) => l && l.pracas.length);

  if (ate) {
    lotes = lotes
      .map((l) => ({ ...l, pracas: l.pracas.filter((p) => p.data <= ate) }))
      .filter((l) => l.pracas.length);
  }

  // datas cobertas, para o front saber o intervalo
  const todasDatas = lotes.flatMap((l) => l.pracas.map((p) => p.data)).sort();

  const saida = {
    fonte: FONTE,
    atualizadoEm: new Date().toISOString(),
    total: lotes.length,
    totalPracas: todasDatas.length,
    primeiraData: todasDatas[0] || null,
    ultimaData: todasDatas[todasDatas.length - 1] || null,
    lotes,
  };

  const motivos = confere(saida, html, cards.length, !ate);
  if (motivos.length && !forcar) {
    console.error('\nNão gravei nada — os dados anteriores continuam no lugar.\n');
    motivos.forEach((m) => console.error(`  - ${m}`));
    console.error(
      '\nO ponto a conferir é parseCard() no scraper.js: as classes do site' +
        '\nprovavelmente mudaram de nome. Para gravar assim mesmo: --forcar'
    );
    process.exit(2);
  }
  if (motivos.length && forcar) {
    console.error('\nA conferência reclamou, mas --forcar foi pedido:\n');
    motivos.forEach((m) => console.error(`  - ${m}`));
    console.error('');
  }

  // O lotes.js precisa existir para pular a gravação: é ele, e não o .json,
  // que o calendário carrega. Faltando, não há o que preservar — regrava.
  const anterior = fs.existsSync(SAIDA_JS) ? leAnterior() : null;
  if (anterior && !forcar && !mudouDeVerdade(anterior, saida)) {
    console.log('\nO acervo está igual ao da última coleta — não reescrevi nada.');
    console.log(`  ${saida.total} lotes | ${saida.totalPracas} datas de praça`);
    console.log(`  dados de ${anterior.atualizadoEm}`);
    return;
  }

  fs.mkdirSync(path.dirname(SAIDA), { recursive: true });
  fs.writeFileSync(SAIDA, JSON.stringify(saida, null, 1), 'utf8');

  // versão .js para o calendário abrir direto do disco (file:// bloqueia fetch)
  fs.writeFileSync(
    SAIDA_JS,
    `window.DADOS_LEILAO = ${JSON.stringify(saida)};\n`,
    'utf8'
  );

  console.log(`\nOK -> ${SAIDA}`);
  console.log(`OK -> ${SAIDA_JS}`);
  console.log(`  ${saida.total} lotes | ${saida.totalPracas} datas de praça`);
  console.log(`  período: ${saida.primeiraData} a ${saida.ultimaData}`);

  // Imóvel novo = id que não estava na coleta anterior. Só compara se havia
  // coleta anterior de verdade — na primeira vez que o site roda, "anterior"
  // é vazio e tudo pareceria novo, disparando um e-mail gigante e falso.
  if (anterior) {
    const idsAntes = new Set(anterior.lotes.map((l) => l.id));
    const novos = saida.lotes.filter((l) => !idsAntes.has(l.id));
    if (novos.length) {
      fs.writeFileSync(
        NOVOS,
        JSON.stringify(novos.map(({ id, titulo, url }) => ({ id, titulo, url })), null, 1),
        'utf8'
      );
      console.log(`\n${novos.length} imóvel(is) novo(s) desde a última coleta:`);
      novos.forEach((l) => console.log(`  - ${l.titulo} -> ${l.url}`));
    } else {
      fs.rmSync(NOVOS, { force: true });
    }
  }

  // resumo por dia
  const porDia = {};
  todasDatas.forEach((d) => (porDia[d] = (porDia[d] || 0) + 1));
  Object.keys(porDia)
    .sort()
    .forEach((d) => console.log(`    ${d}: ${porDia[d]} lote(s)`));
}

main().catch((e) => {
  console.error('Falhou:', e.message);
  process.exit(1);
});
