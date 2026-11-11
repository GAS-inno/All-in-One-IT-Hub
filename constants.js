// Keep these two files in sync.

window.DEPLOYMENT_STATUS = ['In Use', 'In Stock', 'Workshop', 'Retired', 'Disposed'];

window.CONDITION = ['Good', 'Needs Repair', 'End of Life', 'Unknown'];

window.CONDITION_LABELS = {
  'Good': 'Working',
  'Needs Repair': 'Faulty',
  'End of Life': 'Beyond Economic Repair',
  'Unknown': 'Not Assessed',
};

window.DISPOSITION_METHOD = ['Recycle', 'Resell', 'Donate', 'Wipe & Hold'];

window.OLD_DEVICE_OUTCOME = [
  'Re-issued to another user',
  'Sent to workshop for repair',
  'Awaiting re-imaging',
  'Retired pending disposal',
  'Disposed',
];

window.BADGE_COLORS = {
  'In Use': '#3b82f6',
  'In Stock': '#06b6d4',
  'Workshop': '#d97706',
  'Retired': '#6b7280',
  'Disposed': '#dc2626',
  'Good': '#16a34a',
  'Needs Repair': '#ea580c',
  'End of Life': '#b91c1c',
  'Unknown': '#6b7280',
  'Recycle': '#6b7280',
  'Resell': '#2563eb',
  'Donate': '#16a34a',
  'Wipe & Hold': '#7f1d1d',
};
