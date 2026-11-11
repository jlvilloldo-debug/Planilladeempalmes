# Planillas de empalme

Generador de planillas de empalme de fibra óptica a partir de mediciones OTDR (.sor).
Todo se procesa en el navegador: ningún archivo de medición sale de la máquina.

## Publicar en GitHub Pages

1. Crear un repositorio nuevo en GitHub (por ejemplo `planillas-empalme`).
2. Subir **todo el contenido de esta carpeta** tal cual, respetando las subcarpetas `js/` y `vendor/`
   (botón *Add file → Upload files* y arrastrar todo).
3. En el repositorio: *Settings → Pages → Build and deployment → Source: Deploy from a branch*,
   rama `main`, carpeta `/ (root)`, *Save*.
4. En uno o dos minutos queda publicada en `https://USUARIO.github.io/planillas-empalme/`.

Para actualizar la app alcanza con reemplazar los archivos en el repositorio.

## Archivos

- `index.html` — la pantalla.
- `js/app.js` — lectura de .sor, detección de empalmes, armado de Excel/PDF, visor de trazas, licencia.
- `js/arranque.js` — muestra en pantalla cualquier error de carga.
- `vendor/` — librerías incluidas (ExcelJS 4.4.0, JSZip 3.10.1, jsPDF 2.5.1, jsPDF-AutoTable 3.8.2).
  No se descarga nada de terceros al usar la app.
- `sw.js`, `manifest.webmanifest`, `icono.svg` — uso sin conexión e instalación como aplicación.
- `.nojekyll` — le indica a GitHub que publique los archivos sin procesarlos.

## Licencia de uso

La licencia se activa por equipo y por dirección web: en la dirección nueva de GitHub hay que
pegar la clave una vez. El código de equipo es el mismo que en la dirección anterior si se usa
el mismo navegador.
