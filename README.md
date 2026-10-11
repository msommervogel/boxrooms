# BOXROOMS

Survival coop en 3D dans le navigateur (three.js), inspiré de Boxhead 2Play Rooms. Jusqu'à 4 joueurs sur le même écran, et chaque téléphone devient une manette en scannant un QR code.

## Mettre le jeu en ligne avec GitHub Pages

1. Crée un dépôt sur GitHub, par exemple `boxrooms`.
2. Envoie tout le contenu de ce dossier à la racine du dépôt, y compris le dossier `vendor/` et le fichier `.nojekyll`. Tu peux le faire par glisser-déposer dans l'interface GitHub (« Add file » puis « Upload files ») ou en ligne de commande :
   ```bash
   git init
   git add .
   git commit -m "BOXROOMS"
   git branch -M main
   git remote add origin https://github.com/<ton-pseudo>/boxrooms.git
   git push -u origin main
   ```
3. Dans le dépôt, va dans **Settings > Pages**. Sous « Build and deployment », choisis **Deploy from a branch**, la branche `main` et le dossier `/ (root)`, puis enregistre.
4. Au bout d'une minute ou deux, le jeu est disponible sur `https://<ton-pseudo>.github.io/boxrooms/`.

Si tu veux le jeu directement sur `https://<ton-pseudo>.github.io/`, nomme le dépôt `<ton-pseudo>.github.io`.

## Jouer

- Ouvre l'URL sur un ordinateur ou une télé : c'est l'écran de jeu, avec le QR code et un code à 4 caractères.
- Scanne le QR code avec un téléphone, choisis un pseudo, touche « Rejoindre ». Sans QR code, ouvre la même URL sur le téléphone et tape le code.
- Manette téléphone : stick gauche pour bouger, stick droit pour viser et tirer, bouton en haut pour changer d'arme.
- Clavier et souris : Entrée pour rejoindre, ZQSD ou WASD pour bouger, la souris pour viser et tirer, molette ou A/E pour changer d'arme (Q/E en QWERTY), M pour couper le son.
- Manette USB ou Bluetooth : bouton A pour rejoindre, sticks pour bouger et viser, gâchette droite pour tirer, LB/RB pour changer d'arme, Start pour lancer.

## Comment marche la connexion téléphone

Les téléphones se connectent à l'écran de jeu en WebRTC (pair à pair) grâce à [PeerJS](https://peerjs.com). Le serveur public gratuit de PeerJS sert uniquement à mettre les appareils en relation ; ensuite les commandes passent directement entre le téléphone et l'écran.

- Le plus fiable : téléphone et écran sur le même Wi-Fi.
- Certains réseaux d'entreprise ou d'école bloquent WebRTC. En 4G/5G ça marche le plus souvent, mais pas toujours (il faudrait un serveur TURN pour couvrir tous les cas).

## Contenu

- `index.html` : la page
- `style.css` : les styles
- `game.js` : le jeu (écran hôte et manette)
- `vendor/` : three.js r147 et ses passes de post-traitement, qrcode-generator 1.4.4, PeerJS 1.5.4 (copies locales, rien à installer)

Tout est statique : pas de build, pas de serveur à faire tourner. Pour tester en local, sers le dossier en HTTP, par exemple avec `python3 -m http.server`, puis ouvre `http://localhost:8000`.
