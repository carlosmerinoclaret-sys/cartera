# Instalar «Cartera» en tu iPhone (sin Mac, gratis)

Todo se puede hacer desde Safari en el iPhone; con un ordenador cualquiera es aún más cómodo.
Tiempo aproximado: 15 minutos. Solo hay que hacerlo una vez.

Necesitas tres cosas:
1. una clave de **EODHD**, que da los precios de mercado;
2. un **Worker de Cloudflare** gratuito, un pequeño repetidor que hace falta porque EODHD no deja que una web le pida datos directamente;
3. un sitio donde alojar la app: **GitHub Pages**, también gratuito.

---

## 1. Clave de EODHD

1. Entra en https://eodhd.com/register y crea la cuenta.
2. En tu panel copia el **API token**.
   - El plan gratuito da 20 consultas al día y solo sirve para probar.
   - Para el uso diario: «EOD Historical Data — All World», con 50 % de descuento para estudiantes.

## 2. Repetidor en Cloudflare (Worker)

1. Crea una cuenta en https://dash.cloudflare.com/sign-up.
2. En el menú, ve a **Workers & Pages → Create → Create Worker** (plantilla «Hello World»). Ponle de nombre `cartera` y pulsa **Deploy**.
3. Pulsa **Edit code**, borra todo y pega el contenido de `worker.js`. Pulsa **Deploy**.
4. (Recomendado) En **Settings → Variables and Secrets → Add**:
   - Tipo *Secret*, nombre `EODHD_TOKEN`, valor: tu clave de EODHD. Así la clave no se guarda en el móvil.
5. Apunta la dirección del Worker. Tiene esta forma: `https://cartera.TU-SUBDOMINIO.workers.dev`.
   Si la abres en Safari debe mostrar «Cartera: repetidor de datos activo.»

## 3. Publicar la app (GitHub Pages)

1. Descomprime `CarteraWeb.zip`: en la app **Archivos**, toca el zip.
2. Crea una cuenta en https://github.com y luego un repositorio nuevo (**+ → New repository**).
   Llámalo `cartera`, márcalo como **Public** y pulsa **Create**.
3. Toca **uploading an existing file** y sube estos archivos:
   `index.html`, `sw.js`, `manifest.json`, `icon-180.png`, `icon-192.png`, `icon-512.png`.
   Pulsa **Commit changes**. `worker.js` e `INSTALAR.md` no hace falta subirlos.
4. Ve a **Settings → Pages**. En *Build and deployment → Source* elige **Deploy from a branch**, rama `main` y carpeta `/ (root)`, y pulsa **Save**.
5. Espera 1–2 minutos. Tu app estará en `https://TU-USUARIO.github.io/cartera/`.

> En el repositorio solo está el código de la app. Tus inversiones nunca salen de tu iPhone.

## 4. Añadirla a la pantalla de inicio

1. Abre `https://TU-USUARIO.github.io/cartera/` en **Safari**.
2. Toca **Compartir** (cuadrado con flecha) y luego **Añadir a pantalla de inicio → Añadir**.
3. Abre **Cartera** desde el icono: se verá a pantalla completa, como una app.
4. En **Ajustes**:
   - pega la dirección del Worker en «Servidor»;
   - deja vacía la clave si la guardaste en el Worker;
   - pulsa **Guardar y probar**. Debe aparecer «✓ Conexión correcta».
5. Opcional: activa **Bloquear con Face ID** y los **Avisos de cartera**.

## Bueno saber

- **Precios:** las acciones y los ETF llegan con unos 15 minutos de retraso; las criptomonedas y las divisas, con alrededor de 1 minuto. La app indica en cada precio si es tiempo real, retrasado o de mercado cerrado.
- **Cuándo se actualiza:** solo mientras la app está abierta. Una web app no puede trabajar en segundo plano; la versión nativa (Swift), sí.
- **Copias de seguridad:** haz una de vez en cuando desde **Ajustes → Copia de seguridad** (se copia un texto que puedes pegar en Notas). Si borras los datos de Safari, se borra la cartera.
- **Actualizar la app:** cuando haya una versión nueva, sube el `index.html` nuevo al repositorio. La app se actualiza sola.
