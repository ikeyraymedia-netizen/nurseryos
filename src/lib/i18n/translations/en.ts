const en = {
  common: {
    save: 'Save',
    cancel: 'Cancel',
    delete: 'Delete',
    loading: 'Loading…',
    pleaseWait: 'Please wait…',
    back: 'Back',
    backToList: 'Back to list',
    backToTrucks: 'Back to trucks',
    copy: 'Copy',
    copied: 'Copied!',
    yes: 'Yes',
    no: 'No',
    close: 'Close',
    search: 'Search',
    all: 'All',
    unknownDate: 'Unknown date',
    lbs: 'lbs',
    order: 'Order',
    orders: 'Orders',
    signOut: 'Sign out',
    email: 'Email',
    password: 'Password',
    yourName: 'Your name',
    optional: 'optional'
  },
  language: {
    label: 'Language',
    english: 'English',
    spanish: 'Español',
    hint: 'Choose the language for menus and buttons in NurseryOS.'
  },
  welcome: {
    liveDataTitle: 'Everyone on the same live data',
    liveDataBody:
      'Loaders check trucks on their phone. Office sends invoices from a laptop. Same orders, same inventory, same numbers — updated in real time.',
    anytimeBadge: 'Anytime, any device',
    headline: 'Run your nursery from the yard, the office, or the road.',
    subhead:
      'NurseryOS keeps inventory, trucks, invoices, and purchasing in one place — on any phone, tablet, or computer. No app store. Just sign in.',
    phone: 'Phone',
    tablet: 'Tablet',
    computer: 'Computer',
    requestAccess: 'Request access',
    signIn: 'Sign in',
    joinWithCode: 'Join with code',
    signInHint: 'Sign in to your nursery workspace.',
    joinHint: 'Got an invite from your nursery owner? Create your account and join the team.',
    requestHint: 'Tell us about your nursery and we will set up your workspace.',
    inviteCode: 'Invite code',
    nurseryName: 'Nursery name',
    messageOptional: 'Message (optional)',
    sendAccessRequest: 'Send access request',
    requestSent: 'Opening your email app — send the message to complete your request.',
    alreadyHaveAccount: 'Already have an account? Sign in',
    joinNurseryTeam: 'Join nursery team',
    signInAndJoin: 'Sign in and join team',
    haveInviteSignIn: 'Have an invite code? Sign in and join',
    signInWithoutInvite: 'Sign in without an invite code',
    alreadyHaveAccountInvite: 'Already have an account? Sign in with your invite',
    newNurseryRequest: 'New nursery? Request access',
    forgotPassword:
      'Forgot your password? Ask your nursery owner or admin — they can send a reset from Team.',
    questions: 'Questions?',
    atLeast6Chars: 'At least 6 characters',
    features: {
      inventory: {
        title: 'Inventory',
        description: 'Live plant stock, uploads, photos, and availability exports.'
      },
      trucks: {
        title: 'Truck building',
        description: 'Build loads, loading checkoff, pull sheets, and BOLs.'
      },
      invoicing: {
        title: 'Invoicing',
        description: 'Estimates and invoices from the load — email and pay links when you need them.'
      },
      purchasing: {
        title: 'Purchasing',
        description: 'Vendors, POs, bills, and scan vendor invoices into the system.'
      },
      tasks: {
        title: 'Tasks',
        description: 'Weekly task board — assign yard and office work, check it off.'
      },
      reports: {
        title: 'Reports',
        description: 'Sales and operations reporting in one workspace.'
      }
    }
  },
  auth: {
    loading: 'Loading NurseryOS…',
    profileNotFound: 'Your account profile was not found. Request access or join with an invite code.',
    noWorkspace: 'Your account has no nursery workspace yet. Request access or join with an invite code.',
    workspaceNotFound: 'Nursery workspace not found. Please contact support or create a new account.',
    emailInUse: 'That email already has an account. Sign in instead.',
    wrongPassword: 'Email or password is incorrect.',
    authFailed: 'Authentication failed.',
    loadFailed: 'Failed to load nursery workspace.'
  },
  header: {
    workspace: 'NurseryOS Workspace',
    localActive: 'Local Active',
    weights: 'Weights',
    team: 'Team',
    sellerHome: 'Seller home',
    packages: 'Packages',
    pendingOrders: 'Pending Orders',
    completedOrders: 'Completed Orders',
    noPending: 'No pending orders',
    syncToCloud: 'Sync to cloud',
    syncing: 'Syncing…',
    pendingToLoad: 'Pending orders to load',
    shippedToday: 'Shipped today',
    noneShippedToday: 'None shipped today',
    ordersCount: '{{count}} orders',
    shippedCount: '{{count}} shipped'
  },
  nav: {
    orders: 'Orders',
    trucks: 'Trucks',
    inventory: 'Inventory',
    customers: 'Customers',
    purchasing: 'Purchasing',
    reports: 'Reports',
    tasks: 'Tasks',
    inventoryHint: 'Use the main panel to manage live plant inventory.',
    customersHint: 'Manage your customer directory in the main panel.',
    purchasingHint: 'Vendors, purchase orders, receiving, and AP bills in the main panel.',
    reportsHint: 'Ask AI for loading, inventory, sales, and customer reports in the main panel.',
    tasksHint: 'Assign weekly tasks by person. Workers check them off when finished.'
  },
  app: {
    loadingWorkspace: 'Loading workspace…',
    workspaceNotActivated: 'Workspace not activated yet',
    workspaceNotActivatedBody:
      '{{name}} is registered, but no workspaces have been turned on. NurseryOS will enable Orders, Trucks, Customers, and other modules from the seller console.',
    workspaceNotActivatedHint:
      'Team stays available from the header. Workspace tabs appear after activation.',
    selectTruckOrOrder: 'Select a truck or order on the left to start loading.',
    selectItemLeft: 'Select an item on the left.',
    leaveTruckBuilder: 'Leave truck builder? Your changes will be lost.',
    uploadOrder: 'Upload order'
  },
  orders: {
    title: 'Plant Orders',
    searchPlaceholder: 'Search customer or PO…',
    filterAll: 'All',
    filterPending: 'To load',
    filterLoading: 'In progress',
    filterCompleted: 'Loaded',
    statusPending: 'To Load',
    statusLoading: 'In Progress',
    statusCompleted: 'Loaded / Ready',
    deleteConfirm: 'Delete this order?',
    noOrders: 'No orders yet',
    noOrdersHint: 'Upload a customer order to get started.',
    needsInvoice: 'Needs invoice save'
  },
  trucks: {
    title: 'Trucks',
    buildTruck: 'Build truck',
    noTrucks: 'No trucks yet',
    noTrucksHint: 'Build a truck to start loading orders.',
    deleteConfirm: 'Delete this truck?'
  },
  loader: {
    createEstimate: 'Create Estimate',
    createInvoice: 'Create Invoice',
    resetCounts: 'Reset counts?',
    loadAllPlants: 'Load all plants?',
    resetTruck: 'Reset Truck',
    loadAll: 'Load All',
    invoiceNotSaved:
      'Invoice not saved to customer. Pricing is on this order — open invoice and tap Save to Customer.',
    selectSalesRep: 'Select sales rep…',
    stagingLocation: 'Order Staging Location',
    stagingHint: 'Where this plant order is staged out in the yard',
    saving: 'SAVING…',
    assignedCustomer: 'Assigned Customer',
    unassigned: 'Unassigned',
    totalWeight: 'Total Order Weight',
    weightHint: 'Sum of all loaded/pending plants',
    deliveredPulled: 'Delivered/Pulled',
    onTruckProgress: 'On-Truck Progress',
    interactiveList: 'Interactive Loader List',
    plainText: 'Extracted Plain Text',
    addPlant: 'Add Plant / Item to this Order',
    selectSize: 'Select Size…',
    savePlant: 'Save Plant to Order',
    cost: 'Cost',
    copyText: 'Copy Text',
    checkoff: 'Checkoff',
    loaded: 'Loaded',
    pulled: 'Pulled',
    qty: 'Qty',
    plant: 'Plant',
    size: 'Size',
    notes: 'Notes',
    vendor: 'Vendor',
    edit: 'Edit',
    markLoaded: 'Mark loaded',
    markPulled: 'Mark pulled'
  },
  team: {
    languageTitle: 'Your language',
    languageSaved: 'Language updated.',
    languageFailed: 'Could not update language.'
  }
} as const;

export type TranslationDict = typeof en;
export default en;
