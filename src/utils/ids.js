import { v4 as uuidv4 } from 'uuid';

export const newId = (prefix) => `${prefix}_${uuidv4()}`;
export const newCorrelationId = () => `corr_${uuidv4()}`;
