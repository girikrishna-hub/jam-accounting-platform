/**
 * Object and capability model for the accounting platform (design pack, Phase 3).
 *
 * Shared by the server (authoritative access checks) and the web client (workspace
 * registration). The server never trusts the client's copy: it evaluates every
 * request against this table itself.
 */

export const APPLICATION_ID = 'jam-accounting';

export type Role = 'accountant' | 'reviewer' | 'client_viewer';
export const ROLES: readonly Role[] = ['accountant', 'reviewer', 'client_viewer'];

export type ObjectTypeId = 'client-organisation' | 'account' | 'period' | 'journal' | 'customer' | 'fee-note' | 'supplier' | 'expense';
export const OBJECT_TYPE_IDS: readonly ObjectTypeId[] = ['client-organisation', 'account', 'period', 'journal', 'customer', 'fee-note', 'supplier', 'expense'];

export interface CapabilityModel {
  readonly capabilityId: string;
  readonly label: string;
  readonly order: number;
  /** Roles that may view the capability. */
  readonly roles: readonly Role[];
  readonly actionIds: readonly string[];
}

export interface ObjectTypeModel {
  readonly objectTypeId: ObjectTypeId;
  readonly displayName: string;
  readonly version: string;
  readonly defaultCapabilityId: string;
  readonly metadataFields: readonly { fieldId: string; label: string }[];
  readonly headerFieldIds: readonly string[];
  readonly summaryFieldIds: readonly string[];
  readonly statusFieldId?: string;
  readonly capabilities: readonly CapabilityModel[];
}

export interface ActionModel {
  readonly actionId: string;
  readonly label: string;
  readonly objectTypeId: ObjectTypeId;
  readonly capabilityId: string;
  readonly roles: readonly Role[];
  readonly requiresConfirmation: boolean;
  readonly category: string;
}

const ALL: readonly Role[] = ROLES;
const STAFF: readonly Role[] = ['accountant', 'reviewer'];
const PREPARER: readonly Role[] = ['accountant'];
const REVIEWER: readonly Role[] = ['reviewer'];

export const OBJECT_TYPES: readonly ObjectTypeModel[] = [
  {
    objectTypeId: 'client-organisation',
    displayName: 'Client',
    version: '1.0.0',
    defaultCapabilityId: 'overview',
    metadataFields: [
      { fieldId: 'legalName', label: 'Legal name' },
      { fieldId: 'trn', label: 'TRN' },
      { fieldId: 'currency', label: 'Reporting currency' },
      { fieldId: 'financialYearStart', label: 'Financial year starts' },
      { fieldId: 'status', label: 'Status' },
      { fieldId: 'yourRole', label: 'Your role' },
    ],
    headerFieldIds: ['legalName', 'currency'],
    summaryFieldIds: ['trn', 'financialYearStart', 'yourRole'],
    statusFieldId: 'status',
    capabilities: [
      { capabilityId: 'overview', label: 'Overview', order: 10, roles: ALL, actionIds: [] },
      { capabilityId: 'profile', label: 'Profile', order: 20, roles: ALL, actionIds: ['org.profile.update', 'org.controls.update'] },
      { capabilityId: 'chart-of-accounts', label: 'Chart of accounts', order: 30, roles: ALL, actionIds: ['coa.import', 'opening-balances.post'] },
      { capabilityId: 'journals', label: 'Journals', order: 35, roles: ALL, actionIds: ['journal.create'] },
      { capabilityId: 'receivables', label: 'Receivables', order: 37, roles: STAFF, actionIds: ['receivables.settings', 'customer.create', 'fee-note.create', 'receipt.record', 'receipt.reassign'] },
      { capabilityId: 'payables', label: 'Expenses', order: 38, roles: STAFF, actionIds: ['payables.settings', 'supplier.create', 'expense.create', 'supplier-payment.record'] },
      { capabilityId: 'banking', label: 'Bank', order: 39, roles: STAFF, actionIds: ['bank.import', 'bank.match', 'bank.unmatch', 'bank.create', 'bank-rule.delete', 'bank.reconcile', 'bank.sign-off'] },
      { capabilityId: 'periods', label: 'Periods', order: 40, roles: STAFF, actionIds: ['period.open'] },
      { capabilityId: 'trial-balance', label: 'Trial balance', order: 50, roles: ALL, actionIds: [] },
      { capabilityId: 'activity', label: 'Activity', order: 60, roles: ALL, actionIds: [] },
    ],
  },
  {
    objectTypeId: 'account',
    displayName: 'Account',
    version: '1.0.0',
    defaultCapabilityId: 'ledger',
    metadataFields: [
      { fieldId: 'code', label: 'Code' },
      { fieldId: 'type', label: 'Type' },
      { fieldId: 'classification', label: 'Statement classification' },
      { fieldId: 'balance', label: 'Balance' },
      { fieldId: 'status', label: 'Status' },
    ],
    headerFieldIds: ['code', 'type'],
    summaryFieldIds: ['classification', 'balance'],
    statusFieldId: 'status',
    capabilities: [
      { capabilityId: 'ledger', label: 'Ledger', order: 10, roles: ALL, actionIds: [] },
      { capabilityId: 'details', label: 'Details', order: 20, roles: STAFF, actionIds: ['account.update', 'account.deactivate'] },
    ],
  },
  {
    objectTypeId: 'period',
    displayName: 'Accounting period',
    version: '1.0.0',
    defaultCapabilityId: 'status',
    metadataFields: [
      { fieldId: 'startDate', label: 'Starts' },
      { fieldId: 'endDate', label: 'Ends' },
      { fieldId: 'status', label: 'Status' },
      { fieldId: 'reopenCount', label: 'Times reopened' },
    ],
    headerFieldIds: ['startDate', 'endDate'],
    summaryFieldIds: ['reopenCount'],
    statusFieldId: 'status',
    capabilities: [
      { capabilityId: 'status', label: 'Status', order: 10, roles: STAFF, actionIds: [] },
      { capabilityId: 'trial-balance', label: 'Trial balance', order: 20, roles: STAFF, actionIds: [] },
    ],
  },
  {
    objectTypeId: 'journal',
    displayName: 'Journal',
    version: '1.0.0',
    defaultCapabilityId: 'lines',
    metadataFields: [
      { fieldId: 'entryDate', label: 'Date' },
      { fieldId: 'number', label: 'Number' },
      { fieldId: 'total', label: 'Total' },
      { fieldId: 'kind', label: 'Kind' },
      { fieldId: 'status', label: 'Status' },
    ],
    headerFieldIds: ['entryDate', 'number'],
    summaryFieldIds: ['total', 'kind'],
    statusFieldId: 'status',
    capabilities: [
      { capabilityId: 'lines', label: 'Lines', order: 10, roles: ALL, actionIds: ['journal.update', 'journal.submit', 'journal.approve', 'journal.return', 'journal.post', 'journal.discard', 'journal.reverse'] },
      { capabilityId: 'review', label: 'Review trail', order: 20, roles: STAFF, actionIds: [] },
    ],
  },
  {
    objectTypeId: 'customer',
    displayName: 'Customer',
    version: '1.0.0',
    defaultCapabilityId: 'statement',
    metadataFields: [
      { fieldId: 'balance', label: 'Balance owed' },
      { fieldId: 'unallocated', label: 'Unallocated payments' },
      { fieldId: 'retainerHeld', label: 'Retainer held' },
      { fieldId: 'trn', label: 'TRN' },
      { fieldId: 'status', label: 'Status' },
    ],
    headerFieldIds: ['trn'],
    summaryFieldIds: ['balance', 'unallocated', 'retainerHeld'],
    statusFieldId: 'status',
    capabilities: [
      { capabilityId: 'statement', label: 'Statement', order: 10, roles: STAFF, actionIds: [] },
      { capabilityId: 'fee-notes', label: 'Fee notes', order: 20, roles: STAFF, actionIds: [] },
      { capabilityId: 'details', label: 'Details', order: 30, roles: STAFF, actionIds: ['customer.update'] },
    ],
  },
  {
    objectTypeId: 'fee-note',
    displayName: 'Fee note',
    version: '1.0.0',
    defaultCapabilityId: 'details',
    metadataFields: [
      { fieldId: 'customer', label: 'Customer' },
      { fieldId: 'issueDate', label: 'Date' },
      { fieldId: 'total', label: 'Total' },
      { fieldId: 'outstanding', label: 'Outstanding' },
      { fieldId: 'matter', label: 'Matter' },
      { fieldId: 'status', label: 'Status' },
    ],
    headerFieldIds: ['customer', 'issueDate'],
    summaryFieldIds: ['total', 'outstanding', 'matter'],
    statusFieldId: 'status',
    capabilities: [
      { capabilityId: 'details', label: 'Fee note', order: 10, roles: STAFF, actionIds: ['fee-note.update', 'fee-note.discard', 'fee-note.issue', 'fee-note.allocate', 'fee-note.apply-retainer', 'fee-note.credit'] },
      { capabilityId: 'settlement', label: 'Payments and credits', order: 20, roles: STAFF, actionIds: [] },
    ],
  },
  {
    objectTypeId: 'supplier',
    displayName: 'Supplier',
    version: '1.0.0',
    defaultCapabilityId: 'expenses',
    metadataFields: [
      { fieldId: 'owed', label: 'Owed to supplier' },
      { fieldId: 'spent', label: 'Spent this year' },
      { fieldId: 'trn', label: 'TRN' },
      { fieldId: 'status', label: 'Status' },
    ],
    headerFieldIds: ['trn'],
    summaryFieldIds: ['owed', 'spent'],
    statusFieldId: 'status',
    capabilities: [
      { capabilityId: 'expenses', label: 'Expenses and payments', order: 10, roles: STAFF, actionIds: [] },
      { capabilityId: 'details', label: 'Details', order: 20, roles: STAFF, actionIds: ['supplier.update'] },
    ],
  },
  {
    objectTypeId: 'expense',
    displayName: 'Expense',
    version: '1.0.0',
    defaultCapabilityId: 'details',
    metadataFields: [
      { fieldId: 'supplier', label: 'Supplier' },
      { fieldId: 'date', label: 'Date' },
      { fieldId: 'total', label: 'Total' },
      { fieldId: 'settlement', label: 'Paid' },
      { fieldId: 'status', label: 'Status' },
    ],
    headerFieldIds: ['supplier', 'date'],
    summaryFieldIds: ['total', 'settlement'],
    statusFieldId: 'status',
    capabilities: [
      { capabilityId: 'details', label: 'Expense', order: 10, roles: STAFF, actionIds: ['expense.update', 'expense.record', 'expense.discard', 'expense.cancel'] },
    ],
  },
];

export const ACTIONS: readonly ActionModel[] = [
  { actionId: 'org.profile.update', label: 'Save profile', objectTypeId: 'client-organisation', capabilityId: 'profile', roles: PREPARER, requiresConfirmation: false, category: 'edit' },
  { actionId: 'org.controls.update', label: 'Change journal approval', objectTypeId: 'client-organisation', capabilityId: 'profile', roles: REVIEWER, requiresConfirmation: true, category: 'control' },
  { actionId: 'journal.create', label: 'Create journal', objectTypeId: 'client-organisation', capabilityId: 'journals', roles: PREPARER, requiresConfirmation: false, category: 'edit' },
  { actionId: 'journal.update', label: 'Save journal', objectTypeId: 'journal', capabilityId: 'lines', roles: PREPARER, requiresConfirmation: false, category: 'edit' },
  { actionId: 'journal.submit', label: 'Submit for approval', objectTypeId: 'journal', capabilityId: 'lines', roles: PREPARER, requiresConfirmation: false, category: 'workflow' },
  { actionId: 'journal.approve', label: 'Approve journal', objectTypeId: 'journal', capabilityId: 'lines', roles: REVIEWER, requiresConfirmation: true, category: 'workflow' },
  { actionId: 'journal.return', label: 'Return to preparer', objectTypeId: 'journal', capabilityId: 'lines', roles: REVIEWER, requiresConfirmation: false, category: 'workflow' },
  { actionId: 'journal.post', label: 'Post journal', objectTypeId: 'journal', capabilityId: 'lines', roles: PREPARER, requiresConfirmation: true, category: 'post' },
  { actionId: 'journal.discard', label: 'Discard draft', objectTypeId: 'journal', capabilityId: 'lines', roles: PREPARER, requiresConfirmation: true, category: 'edit' },
  { actionId: 'journal.reverse', label: 'Reverse journal', objectTypeId: 'journal', capabilityId: 'lines', roles: PREPARER, requiresConfirmation: true, category: 'post' },
  { actionId: 'coa.import', label: 'Import chart of accounts', objectTypeId: 'client-organisation', capabilityId: 'chart-of-accounts', roles: PREPARER, requiresConfirmation: false, category: 'import' },
  { actionId: 'opening-balances.post', label: 'Post opening balances', objectTypeId: 'client-organisation', capabilityId: 'chart-of-accounts', roles: PREPARER, requiresConfirmation: true, category: 'post' },
  { actionId: 'period.open', label: 'Open next period', objectTypeId: 'client-organisation', capabilityId: 'periods', roles: PREPARER, requiresConfirmation: false, category: 'edit' },
  { actionId: 'account.update', label: 'Save account', objectTypeId: 'account', capabilityId: 'details', roles: PREPARER, requiresConfirmation: false, category: 'edit' },
  { actionId: 'account.deactivate', label: 'Deactivate account', objectTypeId: 'account', capabilityId: 'details', roles: PREPARER, requiresConfirmation: true, category: 'edit' },
  // Slice 3a: receivables
  { actionId: 'receivables.settings', label: 'Save receivables settings', objectTypeId: 'client-organisation', capabilityId: 'receivables', roles: PREPARER, requiresConfirmation: false, category: 'control' },
  { actionId: 'customer.create', label: 'Add customer', objectTypeId: 'client-organisation', capabilityId: 'receivables', roles: PREPARER, requiresConfirmation: false, category: 'edit' },
  { actionId: 'fee-note.create', label: 'New fee note', objectTypeId: 'client-organisation', capabilityId: 'receivables', roles: PREPARER, requiresConfirmation: false, category: 'edit' },
  { actionId: 'receipt.record', label: 'Record receipt', objectTypeId: 'client-organisation', capabilityId: 'receivables', roles: PREPARER, requiresConfirmation: false, category: 'post' },
  { actionId: 'receipt.reassign', label: 'Assign receipt to customer', objectTypeId: 'client-organisation', capabilityId: 'receivables', roles: PREPARER, requiresConfirmation: false, category: 'edit' },
  { actionId: 'customer.update', label: 'Save customer', objectTypeId: 'customer', capabilityId: 'details', roles: PREPARER, requiresConfirmation: false, category: 'edit' },
  { actionId: 'fee-note.update', label: 'Save fee note', objectTypeId: 'fee-note', capabilityId: 'details', roles: PREPARER, requiresConfirmation: false, category: 'edit' },
  { actionId: 'fee-note.discard', label: 'Discard draft', objectTypeId: 'fee-note', capabilityId: 'details', roles: PREPARER, requiresConfirmation: true, category: 'edit' },
  { actionId: 'fee-note.issue', label: 'Issue fee note', objectTypeId: 'fee-note', capabilityId: 'details', roles: PREPARER, requiresConfirmation: true, category: 'post' },
  { actionId: 'fee-note.allocate', label: 'Allocate payment', objectTypeId: 'fee-note', capabilityId: 'details', roles: PREPARER, requiresConfirmation: false, category: 'edit' },
  { actionId: 'fee-note.apply-retainer', label: 'Apply retainer', objectTypeId: 'fee-note', capabilityId: 'details', roles: PREPARER, requiresConfirmation: true, category: 'post' },
  { actionId: 'fee-note.credit', label: 'Issue credit note', objectTypeId: 'fee-note', capabilityId: 'details', roles: PREPARER, requiresConfirmation: true, category: 'post' },
  // Slice 3b: payables and expenses
  { actionId: 'payables.settings', label: 'Save expense settings', objectTypeId: 'client-organisation', capabilityId: 'payables', roles: PREPARER, requiresConfirmation: false, category: 'control' },
  { actionId: 'supplier.create', label: 'Add supplier', objectTypeId: 'client-organisation', capabilityId: 'payables', roles: PREPARER, requiresConfirmation: false, category: 'edit' },
  { actionId: 'expense.create', label: 'New expense', objectTypeId: 'client-organisation', capabilityId: 'payables', roles: PREPARER, requiresConfirmation: false, category: 'edit' },
  { actionId: 'supplier-payment.record', label: 'Pay supplier', objectTypeId: 'client-organisation', capabilityId: 'payables', roles: PREPARER, requiresConfirmation: false, category: 'post' },
  { actionId: 'supplier.update', label: 'Save supplier', objectTypeId: 'supplier', capabilityId: 'details', roles: PREPARER, requiresConfirmation: false, category: 'edit' },
  { actionId: 'expense.update', label: 'Save expense', objectTypeId: 'expense', capabilityId: 'details', roles: PREPARER, requiresConfirmation: false, category: 'edit' },
  { actionId: 'expense.record', label: 'Record expense', objectTypeId: 'expense', capabilityId: 'details', roles: PREPARER, requiresConfirmation: true, category: 'post' },
  { actionId: 'expense.discard', label: 'Discard draft', objectTypeId: 'expense', capabilityId: 'details', roles: PREPARER, requiresConfirmation: true, category: 'edit' },
  { actionId: 'expense.cancel', label: 'Cancel expense', objectTypeId: 'expense', capabilityId: 'details', roles: PREPARER, requiresConfirmation: true, category: 'post' },
  // Slice 4: bank reconciliation
  { actionId: 'bank.import', label: 'Import statement', objectTypeId: 'client-organisation', capabilityId: 'banking', roles: PREPARER, requiresConfirmation: false, category: 'import' },
  { actionId: 'bank.match', label: 'Match', objectTypeId: 'client-organisation', capabilityId: 'banking', roles: PREPARER, requiresConfirmation: false, category: 'edit' },
  { actionId: 'bank.unmatch', label: 'Unmatch', objectTypeId: 'client-organisation', capabilityId: 'banking', roles: PREPARER, requiresConfirmation: false, category: 'edit' },
  { actionId: 'bank.create', label: 'Enter from bank line', objectTypeId: 'client-organisation', capabilityId: 'banking', roles: PREPARER, requiresConfirmation: false, category: 'post' },
  { actionId: 'bank-rule.delete', label: 'Delete rule', objectTypeId: 'client-organisation', capabilityId: 'banking', roles: PREPARER, requiresConfirmation: true, category: 'edit' },
  { actionId: 'bank.reconcile', label: 'Complete reconciliation', objectTypeId: 'client-organisation', capabilityId: 'banking', roles: PREPARER, requiresConfirmation: true, category: 'workflow' },
  { actionId: 'bank.sign-off', label: 'Sign off reconciliation', objectTypeId: 'client-organisation', capabilityId: 'banking', roles: REVIEWER, requiresConfirmation: true, category: 'workflow' },
];

export function objectTypeModel(objectTypeId: string): ObjectTypeModel | undefined {
  return OBJECT_TYPES.find((t) => t.objectTypeId === objectTypeId);
}

export function actionModel(actionId: string): ActionModel | undefined {
  return ACTIONS.find((a) => a.actionId === actionId);
}

/** Whether a role may view a capability of an object type. Unknown capability → false. */
export function canViewCapability(role: Role, objectTypeId: string, capabilityId: string): boolean {
  const capability = objectTypeModel(objectTypeId)?.capabilities.find((c) => c.capabilityId === capabilityId);
  return Boolean(capability && capability.roles.includes(role));
}

/** Whether a role may invoke an action on an object type. Unknown action or wrong type → false. */
export function canInvokeAction(role: Role, objectTypeId: string, actionId: string): boolean {
  const action = actionModel(actionId);
  return Boolean(action && action.objectTypeId === objectTypeId && action.roles.includes(role)
    && canViewCapability(role, objectTypeId, action.capabilityId));
}

/** Deep-link path for an object workspace. The server re-resolves and re-authorises every link. */
export function workspacePath(orgId: string, objectTypeId: string, objectId: string, capabilityId?: string): string {
  const parts = ['c', orgId, objectTypeId, objectId, ...(capabilityId ? [capabilityId] : [])];
  return '/' + parts.map(encodeURIComponent).join('/');
}

export const WORKSPACE_PATH_PATTERN = /^\/c\/([0-9a-f-]{36})\/(client-organisation|account|period|journal|customer|fee-note|supplier|expense)\/([A-Za-z0-9_.:-]{1,128})(?:\/([a-z-]{1,64}))?$/;
