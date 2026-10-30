const { getResourceByType } = require('../db');

function normalizeResourceType(resourceType) {
  const value = String(resourceType || '').trim().toLowerCase();
  if (!['mesa', 'silla'].includes(value)) {
    throw new Error('Tipo de recurso inválido. Debe ser mesa o silla.');
  }
  return value;
}

async function validateAvailability(resourceType, quantity) {
  const normalizedQuantity = Number(quantity);
  if (!Number.isSafeInteger(normalizedQuantity) || normalizedQuantity <= 0) {
    throw new Error('La cantidad debe ser mayor a cero.');
  }
  const resource = await getResourceByType(resourceType);
  if (normalizedQuantity > resource.available_quantity + resource.reserved_quantity) {
    throw new Error('No hay suficiente disponibilidad para esta operación.');
  }
  return resource;
}

function buildInventorySummary(resources = []) {
  return {
    totalTables: resources.filter((item) => item.resource_type === 'mesa').reduce((sum, item) => sum + item.total_quantity, 0),
    availableTables: resources.filter((item) => item.resource_type === 'mesa').reduce((sum, item) => sum + item.available_quantity, 0),
    reservedTables: resources.filter((item) => item.resource_type === 'mesa').reduce((sum, item) => sum + item.reserved_quantity, 0),
    borrowedTables: resources.filter((item) => item.resource_type === 'mesa').reduce((sum, item) => sum + item.borrowed_quantity, 0),
    totalChairs: resources.filter((item) => item.resource_type === 'silla').reduce((sum, item) => sum + item.total_quantity, 0),
    availableChairs: resources.filter((item) => item.resource_type === 'silla').reduce((sum, item) => sum + item.available_quantity, 0),
    reservedChairs: resources.filter((item) => item.resource_type === 'silla').reduce((sum, item) => sum + item.reserved_quantity, 0),
    borrowedChairs: resources.filter((item) => item.resource_type === 'silla').reduce((sum, item) => sum + item.borrowed_quantity, 0)
  };
}

module.exports = {
  normalizeResourceType,
  validateAvailability,
  buildInventorySummary
};
