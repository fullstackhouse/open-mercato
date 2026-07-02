export const features = [
  // Admin observability over the push delivery log. There are no self-serve push features:
  // device/token lifecycle lives in the `devices` module, per-user opt-out in `notifications`.
  { id: 'push_notifications.view_deliveries', title: 'View push delivery log', module: 'push_notifications' },
]

export default features
