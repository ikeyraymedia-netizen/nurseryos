import { AppLocale } from './i18n/types';

/** Full-phrase replacements (longest matched first). */
const PLANT_PHRASES: Array<[string, string]> = [
  ['Live Oak', 'Roble vivo'],
  ['Red Oak', 'Roble rojo'],
  ['White Oak', 'Roble blanco'],
  ['Pin Oak', 'Roble pin'],
  ['Willow Oak', 'Roble sauce'],
  ['Shumard Oak', 'Roble Shumard'],
  ['Crape Myrtle', 'Mirto de crepe'],
  ['Crepe Myrtle', 'Mirto de crepe'],
  ['Japanese Maple', 'Arce japonés'],
  ['Red Maple', 'Arce rojo'],
  ['Silver Maple', 'Arce plateado'],
  ['Sugar Maple', 'Arce de azúcar'],
  ['River Birch', 'Abedul de río'],
  ['Eastern Redbud', 'Cercis canadiense'],
  ['Southern Magnolia', 'Magnolia del sur'],
  ['Little Gem Magnolia', 'Magnolia Little Gem'],
  ['Sweet Olive', 'Olivo dulce'],
  ['Sweet Viburnum', 'Viburno dulce'],
  ['Chinese Privet', 'Ligustro chino'],
  ['Wax Leaf Ligustrum', 'Ligustro de hoja cerosa'],
  ['Carolina Jessamine', 'Jazmín de Carolina'],
  ['Confederate Jasmine', 'Jazmín confederado'],
  ['Asiatic Jasmine', 'Jazmín asiático'],
  ['Blue Point Juniper', 'Enebro Blue Point'],
  ['Eastern Red Cedar', 'Cedro rojo oriental'],
  ['Leyland Cypress', 'Ciprés Leyland'],
  ['Green Giant Arborvitae', 'Arborvitae Green Giant'],
  ['Nandina Domestica', 'Nandina doméstica'],
  ['Heavenly Bamboo', 'Bambú sagrado'],
  ['Indian Hawthorn', 'Espino indio'],
  ['Knock Out Rose', 'Rosa Knock Out'],
  ['Drift Rose', 'Rosa Drift'],
  ['Gardenia Jasminoides', 'Gardenia jasminoides'],
  ['Azalea', 'Azalea'],
  ['Camellia', 'Camelia'],
  ['Holly', 'Acebo'],
  ['Boxwood', 'Buxus'],
  ['Loropetalum', 'Loropetalum'],
  ['Pittosporum', 'Pittosporo'],
  ['Podocarpus', 'Podocarpus'],
  ['Palmetto', 'Palmetto'],
  ['Sabal Palm', 'Palma sabal'],
  ['Windmill Palm', 'Palma molino'],
  ['Pindo Palm', 'Palma pindo'],
  ['Mondo Grass', 'Pasto mondo'],
  ['Liriope', 'Liriope'],
  ['Hosta', 'Hosta'],
  ['Fern', 'Helecho'],
  ['Ivy', 'Hiedra'],
  ['Ground Cover', 'Cobertura del suelo'],
  ['Ornamental Grass', 'Pasto ornamental'],
  ['Switch Grass', 'Pasto switch'],
  ['Zoysia Grass', 'Pasto zoysia'],
  ['St Augustine', 'San Agustín'],
  ['Bermuda Grass', 'Pasto bermuda'],
  ['Blue Rug Juniper', 'Enebro Blue Rug'],
  ['Blue Pacific Juniper', 'Enebro Blue Pacific'],
  ['Dwarf Burford Holly', 'Acebo Burford enano'],
  ['Carissa Holly', 'Acebo Carissa'],
  ['Soft Touch Holly', 'Acebo Soft Touch'],
  ['Oak Leaf Holly', 'Acebo hoja de roble'],
  ['Eagleston Holly', 'Acebo Eagleston'],
  ['Yaupon Holly', 'Acebo yaupon'],
  ['Sky Pencil Holly', 'Acebo Sky Pencil'],
  ['Wintergreen Boxwood', 'Buxus wintergreen'],
  ['Green Mountain Boxwood', 'Buxus Green Mountain'],
  ['Sprinter Boxwood', 'Buxus Sprinter'],
  ['Burning Bush', 'Ardilla europea'],
  ['Fire Bush', 'Arbusto de fuego'],
  ['Butterfly Bush', 'Arbusto de mariposas'],
  ['Rosemary', 'Romero'],
  ['Lavender', 'Lavanda'],
  ['Sage', 'Salvia'],
  ['Thyme', 'Tomillo'],
  ['Hydrangea', 'Hydrangea'],
  ['Spirea', 'Espiraea'],
  ['Abelia', 'Abelia'],
  ['Photinia', 'Fotinia'],
  ['Pine Straw', 'Paja de pino'],
  ['Mulch', 'Mulch'],
  ['Top Soil', 'Tierra vegetal'],
  ['Potting Soil', 'Tierra para macetas']
].sort((a, b) => b[0].length - a[0].length);

const PLANT_WORDS: Record<string, string> = {
  Oak: 'Roble',
  Maple: 'Arce',
  Pine: 'Pino',
  Cedar: 'Cedro',
  Cypress: 'Ciprés',
  Juniper: 'Enebro',
  Palm: 'Palma',
  Magnolia: 'Magnolia',
  Dogwood: 'Cornejo',
  Birch: 'Abedul',
  Elm: 'Olmo',
  Ash: 'Fresno',
  Willow: 'Sauce',
  Poplar: 'Álamo',
  Cherry: 'Cerezo',
  Plum: 'Ciruelo',
  Peach: 'Durazno',
  Apple: 'Manzano',
  Pear: 'Peral',
  Fig: 'Higuera',
  Grape: 'Uva',
  Blueberry: 'Arándano',
  Raspberry: 'Frambuesa',
  Strawberry: 'Fresa',
  Rose: 'Rosa',
  Lilac: 'Lila',
  Tulip: 'Tulipán',
  Daisy: 'Margarita',
  Sunflower: 'Girasol',
  Fern: 'Helecho',
  Grass: 'Pasto',
  Tree: 'Árbol',
  Shrub: 'Arbusto',
  Vine: 'Enredadera',
  Perennial: 'Perenne',
  Annual: 'Anual',
  Native: 'Nativo',
  Dwarf: 'Enano',
  Giant: 'Gigante',
  Variegated: 'Variegado',
  Golden: 'Dorado',
  Green: 'Verde',
  Red: 'Rojo',
  White: 'Blanco',
  Blue: 'Azul',
  Purple: 'Morado',
  Pink: 'Rosa',
  Yellow: 'Amarillo',
  Black: 'Negro',
  Silver: 'Plateado',
  Emerald: 'Esmeralda',
  Winter: 'Invierno',
  Summer: 'Verano',
  Spring: 'Primavera',
  Autumn: 'Otoño',
  Fall: 'Otoño',
  Southern: 'Del sur',
  Northern: 'Del norte',
  Eastern: 'Oriental',
  Western: 'Occidental',
  Chinese: 'Chino',
  Japanese: 'Japonés',
  American: 'Americano',
  English: 'Inglés',
  Mexican: 'Mexicano',
  Texas: 'Tejano',
  Louisiana: 'Luisiano',
  Gallon: 'Galón',
  Pot: 'Maceta',
  Container: 'Contenedor',
  Bare: 'Desnuda',
  Root: 'Raíz',
  Ball: 'Bola',
  Balled: 'En bola',
  Burlapped: 'Con manta',
  Liners: 'Plántulas',
  Liner: 'Plántula',
  Plugs: 'Plugs',
  Plug: 'Plug',
  Flat: 'Bandeja',
  Tray: 'Bandeja',
  Pack: 'Paquete',
  Mixed: 'Mixto',
  Assorted: 'Surtido'
};

const SIZE_PHRASES: Array<[string, string]> = [
  ['B&B', 'B&B'],
  ['#45', '#45'],
  ['#25', '#25'],
  ['#15', '#15'],
  ['#7', '#7'],
  ['#5', '#5'],
  ['#3', '#3'],
  ['#2', '#2'],
  ['#1', '#1'],
  ['15 Gallon', '15 galones'],
  ['10 Gallon', '10 galones'],
  ['7 Gallon', '7 galones'],
  ['5 Gallon', '5 galones'],
  ['3 Gallon', '3 galones'],
  ['2 Gallon', '2 galones'],
  ['1 Gallon', '1 galón'],
  ['25 Gallon', '25 galones'],
  ['45 Gallon', '45 galones'],
  ['Flat', 'Bandeja'],
  ['Liner', 'Plántula'],
  ['Plug', 'Plug']
].sort((a, b) => b[0].length - a[0].length);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replacePhrase(text: string, from: string, to: string): string {
  const re = new RegExp(`\\b${escapeRegExp(from)}\\b`, 'gi');
  return text.replace(re, (match) => {
    if (match === match.toUpperCase()) return to.toUpperCase();
    if (match[0] === match[0]?.toUpperCase()) {
      return to.charAt(0).toUpperCase() + to.slice(1);
    }
    return to;
  });
}

function translateWords(text: string): string {
  return text.replace(/\b[A-Za-z][A-Za-z'-]*\b/g, (word) => {
    const direct = PLANT_WORDS[word];
    if (direct) return direct;
    const titled = word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    return PLANT_WORDS[titled] ?? word;
  });
}

/** Display plant name in the user's language (order/inventory text stays English in DB). */
export function displayPlantName(name: string, locale: AppLocale, spanishName?: string | null): string {
  if (locale !== 'es') return name;
  const explicit = spanishName?.trim();
  if (explicit) return explicit;

  let result = name.trim();
  if (!result) return result;

  for (const [en, es] of PLANT_PHRASES) {
    result = replacePhrase(result, en, es);
  }

  return translateWords(result);
}

/** Display container size in the user's language. */
export function displayContainerSize(size: string, locale: AppLocale): string {
  if (locale !== 'es') return size;
  let result = size.trim();
  if (!result) return result;

  for (const [en, es] of SIZE_PHRASES) {
    result = replacePhrase(result, en, es);
  }

  result = result.replace(/gallon/gi, 'galón');
  result = result.replace(/gal\b/gi, 'gal');
  result = result.replace(/pot/gi, 'maceta');
  result = result.replace(/inch/gi, 'pulg');
  result = result.replace(/in\b/gi, 'pulg');

  return result;
}

/** Format a plant line for loaders: "12 x Live Oak (#3)" */
export function displayPlantLine(
  params: { plantName: string; containerSize: string; quantity?: number; spanishName?: string | null },
  locale: AppLocale
): string {
  const name = displayPlantName(params.plantName, locale, params.spanishName);
  const size = displayContainerSize(params.containerSize, locale);
  if (params.quantity != null) {
    return `${params.quantity} x ${name} (${size})`;
  }
  return `${name} (${size})`;
}
