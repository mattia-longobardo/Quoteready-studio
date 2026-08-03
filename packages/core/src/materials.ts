export interface MaterialDefinition {
  id: string;
  label: string;
  densityKgM3: number | null;
  eurPerKg: number | null;
}

export const MATERIALS: MaterialDefinition[] = [
  { id: "unknown", label: "Not specified", densityKgM3: null, eurPerKg: null },
  {
    id: "aluminum_6061",
    label: "Aluminium 6061",
    densityKgM3: 2700,
    eurPerKg: 7.2,
  },
  { id: "mild_steel", label: "Mild steel", densityKgM3: 7850, eurPerKg: 3.4 },
  {
    id: "stainless_304",
    label: "Stainless steel 304",
    densityKgM3: 8000,
    eurPerKg: 9.8,
  },
  { id: "abs", label: "ABS", densityKgM3: 1040, eurPerKg: 18 },
  { id: "pla", label: "PLA", densityKgM3: 1240, eurPerKg: 16 },
];

export function getMaterial(id: string): MaterialDefinition {
  return MATERIALS.find((material) => material.id === id) ?? MATERIALS[0];
}

export function isMaterialId(value: string): boolean {
  return MATERIALS.some((material) => material.id === value);
}
