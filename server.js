const express = require('express');
const path = require('path');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const FORM_URL = 'https://eldni.com/pe/buscar-datos-por-dni';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// Un solo browser reutilizado entre peticiones.
let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true });
  }
  return browserPromise;
}

/**
 * Consulta un DNI en eldni.com usando Playwright:
 *  1) Abre el formulario en un contexto/página nueva.
 *  2) Escribe el DNI y hace click en "Buscar" (submit real del form).
 *  3) Espera a que cargue la página de resultados.
 *  4) Extrae la fila del <tbody> con page.evaluate().
 */
async function consultarDni(dni) {
  const browser = await getBrowser();
  const context = await browser.newContext({ userAgent: USER_AGENT });
  const page = await context.newPage();

  try {
    await page.goto(FORM_URL, { waitUntil: 'networkidle', timeout: 30000 });

    await page.waitForSelector('#dni', { timeout: 10000 });
    await page.fill('#dni', dni);

    // El <form> original hace un submit normal (no AJAX), así que
    // esperamos la navegación junto con el click.
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }),
      page.click('#btn-buscar-datos-por-dni'),
    ]);

    const resultado = await page.evaluate(() => {
      const fila = document.querySelector('table tbody tr');
      if (!fila) return null;

      const celdas = Array.from(fila.querySelectorAll('td')).map((td) =>
        td.textContent.trim()
      );

      if (celdas.length < 4) return null;

      return {
        dni: celdas[0],
        nombres: celdas[1],
        apellidoPaterno: celdas[2],
        apellidoMaterno: celdas[3],
      };
    });

    return resultado;
  } finally {
    await context.close();
  }
}

app.post('/api/consultar', async (req, res) => {
  const dni = (req.body?.dni || '').toString().trim();

  if (!/^\d{8}$/.test(dni)) {
    return res
      .status(400)
      .json({ error: 'Ingresa un DNI válido de 8 dígitos.' });
  }

  try {
    const resultado = await consultarDni(dni);

    if (!resultado) {
      return res
        .status(404)
        .json({ error: 'No se encontraron resultados para ese DNI.' });
    }

    return res.json(resultado);
  } catch (err) {
    console.error('Error consultando DNI:', err.message);
    return res
      .status(502)
      .json({ error: 'No se pudo completar la consulta. Intenta de nuevo.' });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});

process.on('SIGINT', async () => {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
  }
  process.exit(0);
});
