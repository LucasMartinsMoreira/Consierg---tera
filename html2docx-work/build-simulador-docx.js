/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const HTMLtoDOCX = require('html-to-docx/dist/html-to-docx.umd');

const SRC = path.join('C:', 'Users', 'lu.moreira', 'Downloads', 'simulador_viagem_espanhol_v2.html');
const OUT = path.join('C:', 'Users', 'lu.moreira', 'Downloads', 'simulador_viagem_espanhol_v2.docx');

const CAT_NAMES = {
  restaurante: 'Restaurante',
  bar: 'Bar / tapas',
  cafe: 'Café da manhã',
  hotel: 'Hotel',
  taxi: 'Táxi / Uber',
  rua: 'Na rua',
  metro: 'Metrô / ônibus',
  loja: 'Loja',
  farm: 'Farmácia',
  emerg: 'Emergências',
};

function esc(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildLugaresSection() {
  const parts = [];
  parts.push('<h2>Pedir informações sobre lugares</h2>');
  parts.push(
    '<p>Frases úteis para pedir informação sobre <strong>monumentos, museus, miradores, praias, bairros e atrações</strong> durante a viagem.</p>'
  );

  parts.push('<h3>Onde fica e como chegar</h3>');
  parts.push('<ul>');
  const a = [
    ['¿Dónde está el museo / la catedral / el alcázar?', 'Onde fica o museu / a catedral / o alcázar?'],
    ['¿Cómo llego a … desde aquí?', 'Como chego a … daqui?'],
    [
      '¿Está muy lejos si vamos andando?',
      'É muito longe se formos a pé?',
    ],
    ['¿Hay que coger el metro? ¿Qué línea?', 'Preciso pegar o metrô? Que linha?'],
    ['¿Hay autobús turístico (city tour) por aquí?', 'Há ônibus turístico por aqui?'],
    ['¿Me puede indicar en el mapa?', 'Pode me mostrar no mapa?'],
  ];
  for (const [es, pt] of a) {
    parts.push(`<li><strong>${esc(es)}</strong> — <em>${esc(pt)}</em></li>`);
  }
  parts.push('</ul>');

  parts.push('<h3>Horários, filas e bilhetes</h3>');
  parts.push('<ul>');
  const b = [
    ['¿A qué hora abre y cierra?', 'A que horas abre e fecha?'],
    ['¿Qué días está cerrado?', 'Em que dias fecha?'],
    [
      '¿Es necesario reservar la entrada con antelación?',
      'É preciso reservar a entrada com antecedência?',
    ],
    ['¿Cuánto cuesta la entrada? ¿Hay descuento con carné joven?', 'Quanto custa a entrada? Há desconto (jovem / estudante)?'],
    ['¿Hay mucha cola ahora? ¿Cuánto se tarda más o menos?', 'Há muita fila agora? Quanto tempo demora mais ou menos?'],
    ['¿Se puede comprar la entrada por internet / en la taquilla?', 'Dá para comprar online / na bilheteira?'],
    ['¿Hay visitas guiadas en inglés / español?', 'Há visitas guiadas em inglês / espanhol?'],
    ['¿Se puede hacer fotos / grabar vídeo dentro?', 'Dá para tirar fotos / filmar dentro?'],
  ];
  for (const [es, pt] of b) {
    parts.push(`<li><strong>${esc(es)}</strong> — <em>${esc(pt)}</em></li>`);
  }
  parts.push('</ul>');

  parts.push('<h3>O que vale a pena ver</h3>');
  parts.push('<ul>');
  const c = [
    ['¿Qué lugares no me puedo perder?', 'Que lugares não posso perder?'],
    [
      '¿Qué barrio es más auténtico para pasear?',
      'Que bairro é mais autêntico para passear?',
    ],
    [
      '¿Hay algún mirador gratuito con buenas vistas?',
      'Há algum mirante gratuito com boa vista?',
    ],
    ['¿Algún mercado o mercadillo recomendable hoy?', 'Algum mercado ou feira que valha a pena hoje?'],
  ];
  for (const [es, pt] of c) {
    parts.push(`<li><strong>${esc(es)}</strong> — <em>${esc(pt)}</em></li>`);
  }
  parts.push('</ul>');

  parts.push('<h3>Diálogo modelício: posto de informação turística</h3>');
  parts.push(
    '<p><strong>Visitante:</strong> Hola, buenos días. Somos turistas y queremos organizar el día. ¿Qué museo o monumento nos recomienda si solo tenemos una mañana libre?</p>'
  );
  parts.push(
    '<p><strong>Información turística:</strong> Con una mañana, le sugiero … Está a unos quince minutos andando / en metro. Si quiere evitar colas, reserve online.</p>'
  );
  parts.push(
    '<p><strong>Visitante:</strong> Perfecto. ¿Cuánto cuesta la entrada y necesitamos reserva obligatoria?</p>'
  );
  parts.push(
    '<p><strong>Información turística:</strong> Cuesta … euros. Los lunes por la tarde hay horario gratuito, pero hay que reservar plaza con antelación.</p>'
  );
  parts.push(
    '<p><strong>Visitante:</strong> Muchas gracias. ¿Y hay algún restaurante típico cerca sin ser muy caro?</p>'
  );
  parts.push(
    '<p><strong>Información turística:</strong> Sí, en la calle … hay varios sitios. Si quiere, le marco en el plano.</p>'
  );

  parts.push('<hr />');

  return parts.join('\n');
}

function panelToHtml($, panel) {
  const id = $(panel).attr('id') || '';
  const catTitle = CAT_NAMES[id] || id;
  const parts = [`<h2>${esc(catTitle)}</h2>`];

  $(panel)
    .find('> div.sc')
    .each((_, sc) => {
      const $sc = $(sc);
      const head = $sc.find('.sc-head .sc-title').first().text().trim();
      if (head) parts.push(`<h3>${esc(head)}</h3>`);

      const $body = $sc.find('.sc-body').first();

      const tipText = $body.find('.tip').first().text().trim();
      if (tipText) parts.push(`<p><strong>Nota:</strong> ${esc(tipText)}</p>`);

      $body.find('.dlg .line').each((__, line) => {
        const who = $(line).find('.who').first().text().trim();
        const bub = $(line).find('.bub').first().text().trim();
        const tr = $(line).find('.tr').first().text().trim();
        if (who || bub) parts.push(`<p><strong>${esc(who)}:</strong> ${esc(bub)}</p>`);
        if (tr) parts.push(`<p><em>(${esc(tr)})</em></p>`);
      });

      $body.find('.alt-block').each((__, ab) => {
        const altTitle = $(ab).find('.alt-title').first().text().trim();
        if (altTitle) parts.push(`<p><strong>${esc(altTitle)}</strong></p>`);
        $(ab)
          .find('.alt-row')
          .each((___, row) => {
            const t = $(row).text().replace(/\s+/g, ' ').trim();
            if (t) parts.push(`<p>${esc(t)}</p>`);
          });
      });

      $body.find('.vgrid').each((__, vgrid) => {
        const $vg = $(vgrid);
        const $voc = $vg.prev('.voc-title');
        if ($voc.length) parts.push(`<p><strong>${esc($voc.text().trim())}</strong></p>`);
        $vg.find('.vi').each((___, vi) => {
          const t = $(vi).text().replace(/\s+/g, ' ').trim();
          if (t) parts.push(`<p>• ${esc(t)}</p>`);
        });
      });
    });

  return parts.join('\n');
}

async function main() {
  const src = fs.readFileSync(SRC, 'utf8');
  const $ = cheerio.load(src);
  $('style, script').remove();

  const chunks = [];
  chunks.push('<h1>Simulador de viagem — Espanhol (v2)</h1>');
  chunks.push(
    '<p>Diálogos em espanhol com tradução para referência em português. Material para prática de situações reais em viagem.</p>'
  );
  chunks.push(buildLugaresSection());

  $('.w > div.panel').each((_, panel) => {
    chunks.push(panelToHtml($, panel));
  });

  const htmlString = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<title>Simulador de viagem — Espanhol</title>
</head>
<body>
${chunks.join('\n')}
</body>
</html>`;

  const fileBuffer = await HTMLtoDOCX(htmlString, null, {
    title: 'Simulador de viagem — Espanhol (v2)',
    creator: 'Conversão a partir do HTML',
    keywords: ['espanhol', 'viagem', 'diálogos'],
    description: 'Simulador de situações de viagem + pedidos de informação sobre lugares',
    font: 'Calibri',
    fontSize: 22,
    lang: 'es-ES',
  });

  fs.writeFileSync(OUT, fileBuffer);
  console.log('Gravado:', OUT);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
