var robot = require('robotjs');

var tela = robot.getScreenSize();
console.log(`Screen size - x: ${tela.width} y: ${tela.height}`);

var interval =  setInterval(() => {
  var mouse = robot.getMousePos();

  process.stdout.write(`Mouse is at x: ${mouse.x}  y: ${mouse.y} color: ${robot.getPixelColor(mouse.x, mouse.y)}                  \r`);
  if (mouse.x === 0) {
    clearInterval(interval);
    process.stdout.write('\n\n\n');
  }
}, 2000);