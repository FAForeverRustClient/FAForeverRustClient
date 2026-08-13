/** Static country assets shared by chat and player surfaces. */
export const flagSrc = (country: string): string => {
  const code = country.trim().toLowerCase();
  if (!/^[a-z0-9]{2}$/.test(code) || code === "a1" || code === "a2") {
    return "/flags/earth.png";
  }
  return `/flags/${code}.png`;
};
