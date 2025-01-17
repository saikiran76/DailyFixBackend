exports.up = function(knex) {
  return knex.schema.createTable('message_summaries', function(table) {
    table.increments('id').primary();
    table.integer('contact_id').notNullable().references('id').inTable('contacts');
    table.date('date').notNullable();
    table.text('summary').notNullable();
    table.integer('message_count').notNullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());

    // Composite unique index to ensure one summary per contact per day
    table.unique(['contact_id', 'date']);
  });
};

exports.down = function(knex) {
  return knex.schema.dropTable('message_summaries');
}; 