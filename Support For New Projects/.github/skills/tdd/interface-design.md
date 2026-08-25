## Interface Design for Testability

Examples below use C# handlers, repositories, and `Result<T>` return types.

Good interfaces make testing natural:

1. **Accept dependencies, don't create them**

   ```csharp
   // Testable
   public sealed class CreateOrderHandler
   {
      private readonly IOrderRepository _repo;
      private readonly IOrderCacheService _cache;

      public CreateOrderHandler(
         IOrderRepository repo,
         IOrderCacheService cache)
      {
         _repo = repo;
         _cache = cache;
      }
   }

   // Hard to test
   public sealed class CreateOrderHandler
   {
      public async Task<Result<Guid>> Handle(
         CreateOrderCommand request,
         CancellationToken cancellationToken)
      {
         var repo = new SqlOrderRepository(/* real infrastructure */);
         var cache = new OrderCacheService(/* real infrastructure */);

         // ... hidden infrastructure setup ...
         return Result.Ok(Guid.NewGuid());
      }
   }
   ```

2. **Return useful results, don't hide outcomes in side effects**

   ```csharp
   // Testable
   public async Task<Result<Guid>> Handle(
      CreateOrderCommand request,
      CancellationToken cancellationToken)
   {
      var order = Order.Create(request.Number, request.Total);
      await _repo.AddAsync(order, cancellationToken);
      return Result.Ok(order.Id);
   }

   // Hard to test
   public async Task Handle(
      CreateOrderCommand request,
      CancellationToken cancellationToken)
   {
      var order = Order.Create(request.Number, request.Total);
      await _repo.AddAsync(order, cancellationToken);
      _lastCreatedOrderId = order.Id;
   }
   ```

3. **Keep the surface area small**
   - Prefer focused seams like `IOrderCacheService.GetOrFetchAllAsync(...)`
     over giant "do everything" gateways
   - Fewer methods = fewer branches in test setup
   - Fewer parameters = clearer test intent
