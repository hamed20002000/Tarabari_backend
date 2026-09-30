export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const randomBetween = (min: number, max: number) => min + Math.random() * (max - min);
