export const getObjectPosition = (x: number, y: number): string => {
  const posX = 50 + x * 0.5;
  const posY = 50 + y * 0.5;
  return `${posX}% ${posY}%`;
};

export const getTransform = (x: number, y: number, scale: number): string => {
  if (scale === 1) return "none";
  const translateX = x * 0.3;
  const translateY = y * 0.3;
  return `scale(${scale}) translate(${translateX}%, ${translateY}%)`;
};
