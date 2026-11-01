export const TOKENS = {
    
    Logger: Symbol.for("Logger"),
    CacheProvider: Symbol.for("CacheProvider"),
    MessageBroker: Symbol.for("MessageBroker"),
    CoreClient: Symbol.for("CoreClient"),
    WsServer: Symbol.for("WsServer"),
    PermissionCacheService: Symbol.for("PermissionCacheService"),
    CoreDataCacheService: Symbol.for("CoreDataCacheService"),

    
    OrderService: Symbol.for("OrderService"),
    OrderController: Symbol.for("OrderController"),

    
    KashierProvider: Symbol.for("KashierProvider"),
    PaymentService: Symbol.for("PaymentService"),
    KashierWebhookService: Symbol.for("KashierWebhookService"),
    PaymentController: Symbol.for("PaymentController"),
    WebhookController: Symbol.for("WebhookController"),

    
    PresenceService: Symbol.for("PresenceService"),
    AgentService: Symbol.for("AgentService"),
    AgentController: Symbol.for("AgentController"),

    
    AssignmentService: Symbol.for("AssignmentService"),
    AssignmentController: Symbol.for("AssignmentController"),

    
    SettlementService: Symbol.for("SettlementService"),

    
    FinanceService: Symbol.for("FinanceService"),
    FinanceController: Symbol.for("FinanceController"),
};
