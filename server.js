const express = require('express');
const path = require('path');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3000;
const FORM_URL = process.env.FORM_URL || '';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

async function consultarDni(dni) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: USER_AGENT,
  });

  const page = await context.newPage();

  try {
    await page.goto(FORM_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    await page.waitForSelector('#campo-dni', {
      timeout: 20000,
    });

    await page.fill('#campo-dni', dni);

    await page.click('button[data-submit]');

    // Esperamos a que los 3 campos tengan contenido.
    await page.waitForFunction(() => {
      const resultado = document.querySelector('[data-resultado]');

      if (!resultado) {
        return false;
      }

      const valores = Array.from(
        resultado.querySelectorAll('dl dd')
      ).map((dd) => dd.textContent.trim());

      return (
        valores.length >= 3 &&
        valores.every((valor) => valor.length > 0)
      );
    }, { timeout: 30000 });

    // Ahora extraemos los datos
    const resultado = await page.evaluate(() => {
      const contenedor = document.querySelector(
        '[data-resultado]'
      );

      if (!contenedor) {
        return null;
      }

      const datos = {
        nombres: '',
        apellidoPaterno: '',
        apellidoMaterno: '',
      };

      contenedor.querySelectorAll('dl > div').forEach((fila) => {
        const dt = fila.querySelector('dt');
        const dd = fila.querySelector('dd');

        if (!dt || !dd) return;

        const campo = dt.textContent.trim().toLowerCase();
        const valor = dd.textContent.trim();

        if (campo === 'nombres') {
          datos.nombres = valor;
        } else if (campo === 'apellido paterno') {
          datos.apellidoPaterno = valor;
        } else if (campo === 'apellido materno') {
          datos.apellidoMaterno = valor;
        }
      });

      return datos;
    });

    console.log('Resultado DNI:', {
      dni,
      ...resultado,
    });

    return {
      dni,
      ...resultado,
    };

  } catch (error) {
    console.error('Error real (modo debug):', error);

    try {
      console.error('URL actual:', page.url());
      console.error('Título:', await page.title());

      const debug = await page.evaluate(() => ({
        resultado:
          document.querySelector('[data-resultado]')?.outerHTML || null,

        texto:
          document.body?.innerText?.slice(0, 1000) || '',
      }));

      console.error('Debug:', debug);
    } catch (debugError) {
      console.error('Error obteniendo diagnóstico:', debugError);
    }

    throw error;

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

    return res.status(502).json({
      error: 'Error consultando DNI: ' + err.message
      /* error: 'Error real (modo debug): ' + err.message,
      stack: err.stack?.split('\n').slice(0, 5).join('\n'),
      diagnostico: err.diagnostico || null, */
    });
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
