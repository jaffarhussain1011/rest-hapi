var _ = require('lodash');
var assert = require("assert");

module.exports = {
  createSequelizeQuery: function (model, query, Log) {
    var sequelizeQuery = {};

    var queryableFields = model.queryableFields || this.getQueryableFields(model, Log);

    sequelizeQuery = this.setOffsetIfExists(query, sequelizeQuery, Log);

    sequelizeQuery = this.setLimitIfExists(query, sequelizeQuery, Log);

    sequelizeQuery = this.setReturnedAttributes(query, sequelizeQuery, Log);

    sequelizeQuery = this.setSortFields(query, sequelizeQuery, model.routeOptions.associations, Log);

    var defaultWhere = this.createDefaultWhere(query, queryableFields, Log);

    sequelizeQuery = this.setTermSearch(query, sequelizeQuery, queryableFields, defaultWhere, Log);

    if (model.routeOptions) {
      sequelizeQuery.include = this.createIncludeArray(query, model.routeOptions.associations, Log);
    }

    sequelizeQuery.attributes = this.createAttributesFilter(query, model, Log);

    return sequelizeQuery;
  },

  /**
   * Crawls the model's tableAttributes for queryable fields
   * @param {Object} A sequelize model object, specifically uses the tableAttributes property on that object.
   * @returns {string[]} An array of queryable field names
   */
  getQueryableFields: function (model, Log) {
    assert(model, "requires `model` parameter");

    var queryableFields = [];

    var fields = model.schema.paths;
    
    for (var fieldName in fields) {
      var field = fields[fieldName].options;

      if (field.queryable) {
        queryableFields.push(fieldName);
      }
    }

    return queryableFields;
  },

  createAttributesFilter: function (query, model, Log) {
    var attributesFilter = [];

    var fields = model.schema.paths;

    for (var fieldName in fields) {
      var field = fields[fieldName].options;
      if (!field.exclude) {
        attributesFilter.push(fieldName);
      }
    }

    attributesFilter.pop();//EXPL: omit the internal version number
    return attributesFilter.toString().replace(/,/g,' ');
  },

  createIncludeArray: function (query, associations, Log) {
    var includeArray = [];

    if (query.embed && associations) {
      var embedStrings = query.embed.split(",");

      for (var embedStringIndex = 0; embedStringIndex < embedStrings.length; ++embedStringIndex) {
        var embedString = embedStrings[embedStringIndex];

        var embedTokens = embedString.split('.');

        var mainIncludeString = embedTokens[0];
        var subIncludeString = embedTokens[1];

        var association = associations[mainIncludeString];

        if (association) {
          var includeDefinition = {};
          includeDefinition = includeArray.filter(function( include ) {//EXPL: check if the association has already been included
            return include.as == association.include.as;
          });
          includeDefinition = includeDefinition[0];
          if (!includeDefinition) {//EXPL: make a copy of the association include
            includeDefinition = {};
            includeDefinition.model = association.include.model;
            includeDefinition.as = association.include.as;
          }

          if (subIncludeString) {
            if (includeDefinition.model.routeOptions && includeDefinition.model.routeOptions.associations) {
              embedTokens.shift();
              if (includeDefinition.include) {//EXPL: recursively build nested includes
                includeDefinition.include.push(addNestedIncludes(embedTokens, includeDefinition.model.routeOptions.associations, includeDefinition.include, Log));
              } else {
                includeDefinition.include = [addNestedIncludes(embedTokens, includeDefinition.model.routeOptions.associations, [], Log)];
              }
            } else {
              Log.warning("Substring provided but no association exists in model.");
            }
          }
          //EXPL: Add the association if it hasn't already been included
          if (includeArray.indexOf(includeDefinition) < 0) {
            includeArray.push(includeDefinition);
          }
        }
      }
    }
    return includeArray;
  },

  createDefaultWhere: function (query, defaultSearchFields, Log) {

    //TODO: update this to handle more complex queries
    //EX: query = {"or-like-title":"Boat","or-not-description":"boat"
    //should result in
    //$or: [
    //{
    //  title: {
    //    $like: 'Boat'
    //  }
    //},
    //{
    //  description: {
    //    $notIn: 'boat'
    //  }
    //}
    //]

    var defaultWhere = {};

    function parseSearchFieldValue(searchFieldValue)
    {
      if (_.isString(searchFieldValue)) {
        switch (searchFieldValue.toLowerCase()) {
          case "null":
            return null;
            break;
          case "true":
            return true;
            break;
          case "false":
            return false;
            break;
          default:
            return searchFieldValue;
        }
      } else if (_.isArray(searchFieldValue)) {
        searchFieldValue = _.map(searchFieldValue, function (item) {
          switch (item.toLowerCase()) {
            case "null":
              return null;
              break;
            case "true":
              return true;
              break;
            case "false":
              return false;
              break;
            default:
              return item;
          }
        });
        return {$or: searchFieldValue}; //NOTE: Here searchFieldValue is an array.
      }
    }

    if (defaultSearchFields) {
      for (var queryField in query) {
        var index = defaultSearchFields.indexOf(queryField);
        if (index >= 0) { //EXPL: queryField is for basic search value

          var defaultSearchField = defaultSearchFields[index];

          var searchFieldValue = query[defaultSearchField];

          defaultWhere[defaultSearchField] = parseSearchFieldValue(searchFieldValue);

        } else { //EXPL: queryField includes options

          var defaultSearchField = null;
          var searchFieldValue = query[queryField];
          queryField = queryField.split('-');
          if (queryField.length > 1) {
            defaultSearchField = queryField[1];
          }
          queryField = queryField[0];

          if (defaultSearchField) {
            searchFieldValue = parseSearchFieldValue(searchFieldValue);
            switch (queryField) {
              case "not": //EXPL: allows for omitting objects
                if (!defaultWhere[defaultSearchField]) {
                  defaultWhere[defaultSearchField] = {};
                }
                if (_.isArray(searchFieldValue)) {
                  defaultWhere[defaultSearchField]["$notIn"] = searchFieldValue;
                } else {
                  defaultWhere[defaultSearchField]["$notIn"] = [searchFieldValue];
                }
                break;
              case "max": //EXPL: query for max search value
                if (!defaultWhere[defaultSearchField]) {
                  defaultWhere[defaultSearchField] = {};
                }
                defaultWhere[defaultSearchField]["$gte"] = searchFieldValue;
                break;
              case "min": //EXPL: query for min search value
                if (!defaultWhere[defaultSearchField]) {
                  defaultWhere[defaultSearchField] = {};
                }
                defaultWhere[defaultSearchField]["$lte"] = searchFieldValue;
                break;
              case "or":  //EXPL: allows for different properties to be ORed together
                if (!defaultWhere["$or"]) {
                  defaultWhere["$or"] = {};
                }
                defaultWhere["$or"][defaultSearchField] = searchFieldValue;
                break;
              default:
                break;
            }
          }
        }
      }
    }

    return defaultWhere;
  },

  setTermSearch: function (query, sequelizeQuery, defaultSearchFields, defaultWhere, Log) {
    //EXPL: add the term as a regex search
    if (query.term) {
      var searchTerm = query.term;
      //EXPL: remove the "term" from the query
      delete query.term;

      var fieldSearches = undefined;

      if (query.searchFields) {
        var searchFields = query.searchFields.split(",");

        fieldSearches = [];

        //EXPL: add field searches only for those in the query.fields
        for (var fieldIndex in searchFields) {
          var field = searchFields[fieldIndex];
          var fieldSearch = {}
          fieldSearch[field] = {$like: "%" + searchTerm + "%"}
          fieldSearches.push(fieldSearch)
        }

        delete query.searchFields; //EXPL: remove to avoid query conflicts.
      } else {
        var fieldSearches = [];

        //EXPL: add ALL the fields as search fields.
        if (defaultSearchFields) {
          for (var defaultSearchFieldIndex in defaultSearchFields) {
            var defaultSearchField = defaultSearchFields[defaultSearchFieldIndex];

            var searchObject = {};

            searchObject[defaultSearchField] = {$like: "%" + searchTerm + "%"}

            fieldSearches.push(searchObject);
          }
        }
      }

      sequelizeQuery.where = {
        $and: [{
          $or: fieldSearches
        },
          defaultWhere
        ]
      };
    } else {
      sequelizeQuery.where = defaultWhere;
    }

    return sequelizeQuery;
  },

  setSortFields: function (query, sequelizeQuery, modelAssociations, Log) {
    if (query.sort) {
      var fieldSorts = [];

      var sortFields = query.sort.split(",");

      for (var sortFieldIndex in sortFields) {
        var sortField = sortFields[sortFieldIndex];

        var queryAssociations = [];
        var order = sortField[0];
        sortField = sortField.substring(1);
        sortField = sortField.split(".");

        //EXPL: support sorting through nested associations
        if (sortField.length > 1) {
          var association = null;
          while (sortField.length > 1) {
            association = sortField.shift();
            queryAssociations.push(modelAssociations[association].include);
            modelAssociations = modelAssociations[association].include.model.routeOptions.associations;
          }
          sortField = sortField[0];
        } else {
          sortField = sortField[0];
        }

        var sortQuery = null;
        if (order == "-") {
          //EXPL: - means descending.
          if (queryAssociations) {
            sortQuery = queryAssociations;
            sortQuery.push(sortField);
            sortQuery.push('DESC');
            fieldSorts.push(sortQuery);
          } else {
            fieldSorts.push([sortField, "DESC"]);
          }
        } else if (order == "+") {
          //EXPL: + means ascending.
          if (queryAssociations) {
            sortQuery = queryAssociations;
            sortQuery.push(sortField);
            fieldSorts.push(sortQuery);
          } else {
            fieldSorts.push([sortField]);
          }
        } else {
          //EXPL: default to ascending if there is no - or +
          if (queryAssociations) {
            sortQuery = queryAssociations;
            sortQuery.push(sortField);
            fieldSorts.push(sortQuery);
          } else {
            fieldSorts.push([sortField]);
          }
        }
      }

      //EXPL: remove from the query to remove conflicts.
      delete query.sort;

      sequelizeQuery.order = fieldSorts;
    }

    return sequelizeQuery;
  },

  setReturnedAttributes: function (query, sequelizeQuery, Log) {
    if (query.fields) {
      var fields = query.fields.split(",");

      sequelizeQuery.attributes = fields;
    }

    return sequelizeQuery;
  },

  setLimitIfExists: function (query, sequelizeQuery, Log) {
    //TODO: default limit of 20.
    if (query.limit) {
      sequelizeQuery.limit = query.limit;
    }

    return sequelizeQuery;
  },

  setOffsetIfExists: function (query, sequelizeQuery, Log) {
    if (query.offset) {
      sequelizeQuery.offset = query.offset;
    }

    return sequelizeQuery;
  }
};


//EXPL: Recursively add nested includes/embeds
function addNestedIncludes(embedTokens, associations, includeArray, Log) {
  var mainIncludeString = embedTokens[0];
  var subIncludeString = embedTokens[1];

  var association = associations[mainIncludeString];

  if (association) {
    var includeDefinition = {};
    includeDefinition = includeArray.filter(function( include ) {//EXPL: check if the association has already been included
      return include.as == association.include.as;
    });
    includeDefinition = includeDefinition[0];
    if (!includeDefinition) {//EXPL: make a copy of the association include
      includeDefinition = {};
      includeDefinition.model = association.include.model;
      includeDefinition.as = association.include.as;
    }

    if (subIncludeString) {
      if (includeDefinition.model.routeOptions && includeDefinition.model.routeOptions.associations) {
        embedTokens.shift();
        if (includeDefinition.include) {//EXPL: recursively build nested includes
          includeDefinition.include.push(addNestedIncludes(embedTokens, includeDefinition.model.routeOptions.associations, includeDefinition.include, Log));
        } else {
          includeDefinition.include = [addNestedIncludes(embedTokens, includeDefinition.model.routeOptions.associations, [], Log)];
        }
      } else {
        Log.warning("Substring provided but no association exists in model.");
        return includeDefinition;
      }
    }
    return includeDefinition;
  }
  Log.error("Association does not exist!");
  return;
}