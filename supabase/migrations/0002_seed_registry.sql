-- Seed app + operation registry (costs are central config, not product-final).
insert into apps (slug, display_name, status) values
  ('fridge', 'Что приготовить', 'active'),
  ('wardrobe', 'Мой гардероб', 'coming_soon'),
  ('interior', 'Интерьер', 'coming_soon')
on conflict (slug) do nothing;

insert into operations (app_id, operation_key, credit_cost, enabled)
select a.id, o.key, o.cost, true
from apps a
join (values
  ('fridge', 'fridge.scan', 1),
  ('fridge', 'fridge.recipe', 0),
  ('wardrobe', 'wardrobe.scan', 1),
  ('wardrobe', 'wardrobe.outfit', 1),
  ('wardrobe', 'wardrobe.shopping_check', 1),
  ('interior', 'interior.analyze', 2)
) as o (slug, key, cost) on o.slug = a.slug
on conflict (app_id, operation_key) do nothing;
